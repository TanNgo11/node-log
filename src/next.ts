import { runWithStore } from "./context";
import { isLogged, markLogged } from "./error";
import { logHttpRequest, requestContextFields, type HeaderSource, type HttpLogOptions } from "./http";
import type { Logger } from "./logger";
import type { Fields } from "./normalize";
import { installProcessHandlers, logStartup } from "./process";

export interface WithLoggingOptions extends HttpLogOptions {
  /** Route template, e.g. "/api/orders/[id]". Left empty when not given. */
  route?: string;
}

/** Status for Next's control-flow errors (redirect(), notFound(), forbidden()...), else undefined. */
export function nextControlStatus(err: unknown): number | undefined {
  const digest = (err as { digest?: unknown } | null)?.digest;
  if (typeof digest !== "string") return undefined;
  if (digest.startsWith("NEXT_REDIRECT")) {
    const status = Number(digest.split(";")[3]);
    return Number.isInteger(status) && status >= 300 ? status : 307;
  }
  if (digest === "NEXT_NOT_FOUND") return 404;
  if (digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")) return Number(digest.split(";")[1]) || 404;
  return undefined;
}

function asError(value: unknown): unknown {
  if (typeof value === "object" && value !== null) return value;
  return Object.assign(new Error(String(value)), { name: "NonErrorThrown", thrown: value });
}

function trySetHeader(res: Response, name: string, value: string): void {
  try {
    res.headers.set(name, value);
  } catch {
    // Some responses (Response.redirect, proxied fetch responses) have immutable headers.
  }
}

/** Wraps an App Router route handler: request context + one http.request line. */
export function withLogging<R extends Request, C>(
  log: Logger,
  handler: (request: R, context: C) => Response | Promise<Response>,
  opts: WithLoggingOptions = {},
): (request: R, context: C) => Promise<Response> {
  return (request, context) => {
    const ctx = requestContextFields(request.headers);
    const path = new URL(request.url).pathname;
    const start = performance.now();
    return runWithStore(ctx, async (store) => {
      const summary = (status: number, err: unknown) =>
        logHttpRequest(
          log,
          {
            method: request.method,
            route: opts.route,
            path,
            status,
            duration_ms: performance.now() - start,
            err,
            fields: store.fields,
          },
          opts,
        );
      try {
        const res = await handler(request, context);
        summary(res.status, store.error);
        trySetHeader(res, "x-request-id", ctx.request_id);
        return res;
      } catch (caught) {
        const control = nextControlStatus(caught);
        // Non-objects cannot be marked as logged, so onRequestError would log them again.
        const err = control === undefined ? asError(caught) : caught;
        summary(control ?? 500, control === undefined ? err : store.error);
        throw err;
      }
    });
  };
}

export interface NextRequestInfo {
  path?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
}

export interface NextErrorContext {
  routerKind?: string;
  routePath?: string;
  routeType?: string;
}

/** `export const onRequestError = nextOnRequestError(log)` in instrumentation.ts. */
export function nextOnRequestError(log: Logger, opts: HttpLogOptions = {}) {
  return async (err: unknown, request: NextRequestInfo, context: NextErrorContext): Promise<void> => {
    if (isLogged(err) || nextControlStatus(err) !== undefined) return;
    const digest = (err as { digest?: unknown } | null)?.digest;
    logHttpRequest(
      log,
      {
        method: request?.method ?? "GET",
        route: context?.routePath,
        path: request?.path ?? "",
        status: 500,
        err,
        fields: {
          ...requestContextFields(request?.headers ?? {}),
          next_route_type: context?.routeType,
          next_router_kind: context?.routerKind,
          next_digest: typeof digest === "string" ? digest : undefined,
        },
      },
      opts,
    );
  };
}

/** Call from `register()` in instrumentation.ts. Does nothing on the edge runtime. */
export function registerNext(log: Logger, fields?: Fields): void {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") return;
  // Next keeps serving after an unhandled rejection, so do not exit.
  installProcessHandlers(log, { exitOnCrash: false });
  logStartup(log, { port: process.env.PORT ? Number(process.env.PORT) : undefined, ...fields });
}

export interface WithActionOptions {
  /** Request headers source. Defaults to `headers()` from next/headers. */
  headers?: () => HeaderSource | Promise<HeaderSource>;
}

async function nextHeaders(): Promise<HeaderSource> {
  try {
    const mod = (await import("next/headers")) as { headers: () => HeaderSource | Promise<HeaderSource> };
    return await mod.headers();
  } catch {
    // Called outside a request (tests, scripts) or Next is not installed.
    return {};
  }
}

/**
 * Wraps a server action: request context (request_id from x-request-id) plus one
 * `action.completed` / `action.failed` line. redirect()/notFound() count as completed.
 */
export function withAction<A extends unknown[], R>(
  log: Logger,
  name: string,
  action: (...args: A) => Promise<R>,
  opts: WithActionOptions = {},
): (...args: A) => Promise<R> {
  return async (...args) => {
    const headers = await (opts.headers ?? nextHeaders)();
    const start = performance.now();
    return runWithStore({ ...requestContextFields(headers), action_name: name }, async (store) => {
      const fields = () => ({ ...store.fields, duration_ms: Math.round(performance.now() - start) });
      try {
        const result = await action(...args);
        log.info("server action completed", { ...fields(), event: "action.completed", err: store.error });
        return result;
      } catch (caught) {
        const control = nextControlStatus(caught);
        if (control !== undefined) {
          log.info("server action completed", { ...fields(), event: "action.completed", next_control_status: control });
          throw caught;
        }
        const err = asError(caught);
        log.error("server action failed", { ...fields(), event: "action.failed", err });
        markLogged(err);
        throw err;
      }
    });
  };
}
