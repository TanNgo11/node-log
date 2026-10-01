import { runWithStore } from "./context";
import { isLogged } from "./error";
import { logHttpRequest, requestContextFields, type HttpLogOptions } from "./http";
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

function trySetHeader(res: Response, name: string, value: string): void {
  try {
    res.headers.set(name, value);
  } catch {
    // Some responses (Response.redirect, proxied fetch responses) have immutable headers.
  }
}

/** Wraps an App Router route handler: request context + one http.request line. */
export function withLogging<C>(
  log: Logger,
  handler: (request: Request, context: C) => Response | Promise<Response>,
  opts: WithLoggingOptions = {},
): (request: Request, context: C) => Promise<Response> {
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
      } catch (err) {
        const control = nextControlStatus(err);
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
