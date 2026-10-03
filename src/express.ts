import type { ErrorRequestHandler, RequestHandler } from "express";
import { attachStore, recordErrorIn, runWithStore, storeOf, type ContextStore } from "./context";
import { logHttpRequest, requestContextFields, type HttpLogOptions } from "./http";
import type { Logger } from "./logger";

function joinRoute(baseUrl: string | undefined, path: unknown): string {
  return `${baseUrl ?? ""}${String(path)}` || "/";
}

// Express assigns req.route when a route matches, while req.baseUrl still holds the mount
// path. It resets baseUrl before the response ends, so capture the full template here.
function captureRoute(req: { baseUrl?: string }, store: ContextStore): void {
  let value: unknown;
  Object.defineProperty(req, "route", {
    configurable: true,
    enumerable: true,
    get: () => value,
    set: (route: { path?: unknown } | undefined) => {
      value = route;
      if (route?.path !== undefined) store.route = joinRoute(req.baseUrl, route.path);
    },
  });
}

/** Mount before routes. Opens the request context and writes the http.request line. */
export function requestLogger(log: Logger, opts: HttpLogOptions = {}): RequestHandler {
  return (req, res, next) => {
    const ctx = requestContextFields(req.headers);
    res.setHeader("x-request-id", ctx.request_id);
    const start = performance.now();
    runWithStore(ctx, (store) => {
      attachStore(res, store);
      captureRoute(req, store);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        logHttpRequest(
          log,
          {
            method: req.method,
            route: store.route,
            path: req.originalUrl,
            status: res.writableFinished || res.headersSent ? res.statusCode : 499,
            duration_ms: performance.now() - start,
            err: store.error,
            fields: store.fields,
          },
          opts,
        );
      };
      res.once("finish", finish);
      res.once("close", finish);
      next();
    });
  };
}

/** Mount after routes, before your own error handler. Records the error for the summary line. */
export function errorRecorder(): ErrorRequestHandler {
  return (err, _req, res, next) => {
    const store = storeOf(res);
    if (store) recordErrorIn(store, err);
    next(err);
  };
}
