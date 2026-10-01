import type { FastifyPluginCallback } from "fastify";
import { attachStore, recordErrorIn, runWithStore, storeOf } from "./context";
import { logHttpRequest, requestContextFields, type HttpLogOptions } from "./http";
import type { Logger } from "./logger";

export interface FastifyLoggerOptions extends HttpLogOptions {
  log: Logger;
}

const starts = new WeakMap<object, number>();

const plugin: FastifyPluginCallback<FastifyLoggerOptions> = (app, opts, done) => {
  app.addHook("onRequest", (req, reply, next) => {
    const ctx = requestContextFields(req.headers);
    reply.header("x-request-id", ctx.request_id);
    starts.set(reply, performance.now());
    runWithStore(ctx, (store) => {
      attachStore(reply, store);
      next();
    });
  });
  app.addHook("onError", (_req, reply, err, next) => {
    const store = storeOf(reply);
    if (store) recordErrorIn(store, err);
    next();
  });
  app.addHook("onResponse", (req, reply, next) => {
    const store = storeOf(reply);
    const start = starts.get(reply);
    logHttpRequest(
      opts.log,
      {
        method: req.method,
        route: req.routeOptions?.url,
        path: req.url,
        status: reply.statusCode,
        duration_ms: start === undefined ? undefined : performance.now() - start,
        err: store?.error,
        fields: store?.fields,
      },
      opts,
    );
    next();
  });
  done();
};

// Same effect as fastify-plugin: hooks apply to the whole app, not an encapsulated child.
(plugin as unknown as Record<symbol, boolean>)[Symbol.for("skip-override")] = true;

export const fastifyLogger = plugin;
