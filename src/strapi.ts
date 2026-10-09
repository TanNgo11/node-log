import { Writable } from "node:stream";
import { currentStore, recordErrorIn, runWithStore } from "./context";
import { isErrorLike, isLogged, markLogged } from "./error";
import { logHttpRequest, newRequestId, parseTraceparent, REQUEST_ID_RE, type HttpLogOptions } from "./http";
import type { Level } from "./levels";
import type { Logger } from "./logger";
import type { Fields } from "./normalize";

/** The parts of a Koa/Strapi context the middlewares use. */
export interface KoaContextLike {
  method: string;
  url: string;
  status: number;
  state: Record<string, unknown>;
  get(name: string): string;
  set(name: string, value: string): void;
  /** Full matched route template, set by @koa/router (includes router prefixes such as /api). */
  _matchedRoute?: unknown;
}

export type KoaMiddleware = (ctx: KoaContextLike, next: () => Promise<unknown>) => Promise<void>;

export interface StrapiRequestLoggerOptions extends HttpLogOptions {
  log: Logger;
  /**
   * Use a valid incoming x-request-id as request_id. Off by default: the server issues its own
   * id (Strapi apps often use it for audit rows) and records the caller's id as
   * upstream_request_id, which still links the logs of both services.
   */
  trustIncomingRequestId?: boolean;
  /** ctx.state key shared with the app's own correlation middleware. Default "requestId". */
  stateKey?: string;
}

function routeOf(ctx: KoaContextLike): string | undefined {
  if (typeof ctx._matchedRoute === "string") return ctx._matchedRoute;
  const path = (ctx.state.route as { path?: unknown } | undefined)?.path;
  return typeof path === "string" ? path : undefined;
}

/**
 * Replaces 'strapi::logger' (put it first in config/middlewares): opens the request context and
 * writes one http.request line per request.
 */
export function strapiRequestLogger(opts: StrapiRequestLoggerOptions): KoaMiddleware {
  const stateKey = opts.stateKey ?? "requestId";
  return async (ctx, next) => {
    const incoming = ctx.get("x-request-id");
    const caller = incoming && REQUEST_ID_RE.test(incoming) ? incoming : undefined;
    const existing = ctx.state[stateKey];
    const requestId =
      typeof existing === "string" && existing ? existing : opts.trustIncomingRequestId && caller ? caller : newRequestId();
    // A UUID v4 here is kept by correlation middlewares that only replace invalid ids.
    if (ctx.state[stateKey] === undefined) ctx.state[stateKey] = requestId;
    ctx.set("X-Request-ID", requestId);

    const fields: Fields = { request_id: requestId };
    if (caller && caller !== requestId) fields.upstream_request_id = caller;
    const trace = parseTraceparent(ctx.get("traceparent"));
    if (trace) Object.assign(fields, trace);

    const start = performance.now();
    await runWithStore(fields, async (store) => {
      let failed = false;
      try {
        await next();
      } catch (err) {
        // Only reached when no error middleware handled it; Koa answers 500.
        failed = true;
        recordErrorIn(store, err);
        throw err;
      } finally {
        logHttpRequest(
          opts.log,
          {
            method: ctx.method,
            route: routeOf(ctx),
            path: ctx.url,
            status: failed ? 500 : ctx.status,
            duration_ms: performance.now() - start,
            err: store.error,
            fields: store.fields,
          },
          opts,
        );
      }
    });
  };
}

/**
 * Put right after 'strapi::errors'. Records thrown errors on the request's http.request line and
 * marks them, so the copy strapi::errors logs through strapi.log.error is not written twice.
 */
export function strapiErrorCapture(): KoaMiddleware {
  return async (_ctx, next) => {
    try {
      await next();
    } catch (err) {
      const store = currentStore();
      if (store) recordErrorIn(store, err);
      markLogged(err);
      throw err;
    }
  };
}

/** The part of a Koa application (strapi.server.app) strapiServerErrors uses. */
export interface KoaAppLike {
  on(event: "error", listener: (err: unknown, ctx?: KoaContextLike) => void): unknown;
}

/**
 * Replaces Koa's default app.onerror, which prints the stack with console.error as many plain
 * stderr lines (stream errors such as "aborted" or "Parse Error" that never reach a middleware).
 * Writes one `http.server_error` line instead. Call it in register() of src/index.ts, before the
 * first request: `strapiServerErrors(strapi.server.app, log)`.
 */
export function strapiServerErrors(app: KoaAppLike, log: Logger, opts: { stateKey?: string } = {}): void {
  const stateKey = opts.stateKey ?? "requestId";
  // Koa installs its printer only when the app has no error listener of its own.
  app.on("error", (err, ctx) => {
    if (isLogged(err)) return;
    const e = err as { status?: unknown; expose?: unknown } | null;
    // Koa's printer skips these too: 404s and client errors already on the http.request line.
    if (e?.status === 404 || e?.expose === true) return;
    const status = typeof e?.status === "number" ? e.status : 500;
    const fields: Fields = { event: "http.server_error", err };
    const client = isClientDisconnect(err);
    if (client) fields.client_disconnect = true;
    if (ctx) {
      const requestId = ctx.state?.[stateKey];
      if (typeof requestId === "string" && currentStore()?.fields.request_id === undefined) fields.request_id = requestId;
      fields.http_method = ctx.method;
      fields.http_path = ctx.url;
    }
    markLogged(err);
    log[status >= 500 && !client ? "error" : "warn"]("http server error", fields);
  });
}

// The client hung up or sent a malformed request: worth a warn, not an error on our side.
function isClientDisconnect(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : "";
  return (
    code === "ECONNRESET" ||
    code === "ECONNABORTED" ||
    code === "EPIPE" ||
    code === "ERR_STREAM_PREMATURE_CLOSE" ||
    code.startsWith("HPE_") ||
    e?.message === "aborted"
  );
}

const LEVELS: Record<string, Level> = {
  error: "error",
  warn: "warn",
  info: "info",
  http: "debug",
  verbose: "debug",
  debug: "debug",
  silly: "trace",
};

const META_SKIP = new Set(["level", "message", "stack"]);

function forward(log: Logger, info: Record<string, unknown>): void {
  // Already carried by the request's http.request line (see strapiErrorCapture).
  if (isErrorLike(info) && isLogged(info)) return;
  const level = LEVELS[String(info.level)] ?? "info";
  const fields: Fields = {};
  for (const [key, value] of Object.entries(info)) if (!META_SKIP.has(key)) fields[key] = value;

  let message: unknown = info.message;
  if (isErrorLike(info)) {
    fields.err = info;
  } else if (isErrorLike(message)) {
    if (isLogged(message)) return;
    fields.err = message;
    message = message.message;
  } else if (typeof info.stack === "string") {
    fields.err_stack = info.stack;
  }
  if ((level === "warn" || level === "error") && fields.event === undefined) fields.event = "strapi.log";
  log[level](typeof message === "string" ? message : String(message ?? ""), fields);
}

/**
 * Winston configuration for Strapi's config/logger.ts: every strapi.log.* call (app code and
 * framework) becomes a contract JSON line with the request context. Level filtering is left to
 * the logger (LOG_LEVEL).
 */
export function strapiLoggerConfig(log: Logger) {
  // The winston logger that pipes into this transport; its level can change at runtime
  // (Strapi's data export/import commands set it to "error").
  let parent: { level?: string; levels?: Record<string, number> } | undefined;
  const allowed = (info: Record<string, unknown>): boolean => {
    const rank = parent?.levels?.[String(info.level)];
    const max = parent?.level === undefined ? undefined : parent.levels?.[parent.level];
    return rank === undefined || max === undefined || rank <= max;
  };
  const transport = new Writable({
    objectMode: true,
    write(info: Record<string, unknown>, _encoding, callback) {
      try {
        if (allowed(info)) forward(log, info);
      } finally {
        callback();
      }
    },
  });
  transport.on("pipe", (source: unknown) => {
    parent = source as typeof parent;
  });
  // winston requires a `log(info, callback)` method on stream transports; writes go through write().
  Object.assign(transport, {
    log(info: Record<string, unknown>, callback: () => void) {
      forward(log, info);
      callback();
    },
  });
  return {
    level: "silly",
    // Identity format: replaces Strapi's prettyPrint so the transport receives raw info objects.
    format: { transform: <T>(info: T): T => info },
    transports: [transport],
  };
}
