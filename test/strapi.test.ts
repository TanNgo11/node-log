import Router from "@koa/router";
import Koa from "koa";
import type { AddressInfo } from "node:net";
import winston from "winston";
import { afterEach, describe, expect, it } from "vitest";
import { strapiErrorCapture, strapiLoggerConfig, strapiRequestLogger, type StrapiRequestLoggerOptions } from "../src/strapi";
import { capture } from "./helpers";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

let close: (() => void) | undefined;
afterEach(() => {
  close?.();
  close = undefined;
});

// Mirrors the Strapi 5.51 stack: strapi::logger replaced by ours, strapi::errors, our error
// capture, the app's request-correlation middleware, then the router mounted under /api.
async function start(opts: Partial<StrapiRequestLoggerOptions> = {}) {
  const cap = capture();
  // Same construction as @strapi/logger createLogger: defaults overridden by config/logger.
  const defaults = {
    level: "http",
    levels: winston.config.npm.levels,
    format: winston.format.simple(),
    transports: [new winston.transports.Console()] as winston.transport[],
  };
  const strapiLog = winston.createLogger(Object.assign(defaults, strapiLoggerConfig(cap.log)));

  const app = new Koa();
  app.use(strapiRequestLogger({ log: cap.log, ...opts }));
  app.use(async (ctx, next) => {
    // strapi::errors (5.51): known HTTP errors become responses, others are logged then 500.
    try {
      await next();
    } catch (error) {
      if (error instanceof HttpError) {
        ctx.status = error.status;
        ctx.body = { error: error.message };
        return;
      }
      strapiLog.error(error);
      ctx.status = 500;
      ctx.body = { error: "Internal Server Error" };
    }
  });
  app.use(strapiErrorCapture());
  app.use(async (ctx, next) => {
    // request-correlation from the app: keeps a canonical UUID already in state.
    const current = ctx.state.requestId;
    const id = typeof current === "string" && UUID_RE.test(current) ? current : crypto.randomUUID();
    ctx.state.requestId = id;
    ctx.set("X-Request-ID", id);
    await next();
  });

  const router = new Router({ prefix: "/api" });
  router.get("/articles/:id", async (ctx) => {
    await new Promise((r) => setTimeout(r, 1));
    strapiLog.info("article loaded", { event: "article.loaded", articleId: ctx.params.id });
    ctx.body = { id: ctx.params.id };
  });
  router.get("/boom", async () => {
    throw new Error("db down");
  });
  router.get("/forbidden", async () => {
    throw new HttpError("nope", 403);
  });
  router.get("/handled", async (ctx) => {
    strapiLog.error(new Error("payment provider timeout"));
    ctx.body = { ok: true };
  });
  app.use(router.routes());

  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  close = () => server.close();
  return { ...cap, strapiLog, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("strapiRequestLogger", () => {
  it("writes http.request with the full route and shares the app's canonical request id", async () => {
    const { base, lines } = await start();
    const res = await fetch(`${base}/api/articles/7?populate=*`, { headers: { "x-request-id": "bff-req-1" } });
    await settle();
    const [inner, summary] = lines();
    const id = res.headers.get("x-request-id");
    expect(id).toMatch(UUID_RE);
    expect(inner).toMatchObject({ level: "info", message: "article loaded", event: "article.loaded", article_id: "7", request_id: id });
    expect(summary).toMatchObject({
      level: "info",
      event: "http.request",
      http_method: "GET",
      http_route: "/api/articles/:id",
      http_path: "/api/articles/7",
      http_status: 200,
      request_id: id,
      upstream_request_id: "bff-req-1",
    });
  });

  it("writes one error line for an unhandled error, not a second strapi::errors line", async () => {
    const { base, lines } = await start();
    await fetch(`${base}/api/boom`);
    await settle();
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ level: "error", event: "http.request", http_status: 500, http_route: "/api/boom", err_message: "db down" });
    expect(typeof lines()[0]!.err_stack).toBe("string");
  });

  it("keeps errors the app logs itself as their own lines", async () => {
    const { base, lines } = await start();
    await fetch(`${base}/api/handled`);
    await settle();
    expect(lines().map((l) => [l.level, l.event])).toEqual([
      ["error", "strapi.log"],
      ["info", "http.request"],
    ]);
    expect(lines()[0]).toMatchObject({ message: "payment provider timeout", err_message: "payment provider timeout" });
  });

  it("logs handled HTTP errors at warn with the error message but no stack", async () => {
    const { base, lines } = await start();
    await fetch(`${base}/api/forbidden`);
    await settle();
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ level: "warn", http_status: 403, http_route: "/api/forbidden", err_message: "nope" });
    expect(lines()[0]!.err_stack).toBeUndefined();
  });

  it("can trust an incoming x-request-id when asked", async () => {
    const id = "3f2b8c1e-9a4d-4c7e-8b1a-2d3e4f5a6b7c";
    const { base, lines } = await start({ trustIncomingRequestId: true });
    await fetch(`${base}/api/articles/1`, { headers: { "x-request-id": id } });
    await settle();
    expect(lines()[1]).toMatchObject({ request_id: id });
    expect(lines()[1]!.upstream_request_id).toBeUndefined();
  });
});

describe("strapiLoggerConfig", () => {
  it("maps winston levels and metadata outside requests", async () => {
    const { strapiLog, lines } = await start();
    strapiLog.warn("cron job skipped", { jobName: "expire_listings" });
    strapiLog.http("GET /admin (3 ms) 200");
    strapiLog.verbose("details");
    strapiLog.silly("noise");
    expect(lines()).toMatchObject([
      { level: "warn", message: "cron job skipped", event: "strapi.log", job_name: "expire_listings" },
      { level: "debug", message: "GET /admin (3 ms) 200" },
      { level: "debug", message: "details" },
      { level: "trace", message: "noise" },
    ]);
  });
});

describe("strapiLoggerConfig level", () => {
  it("honours a level set on the winston logger at runtime (Strapi CLI quiets logs this way)", async () => {
    const { strapiLog, lines } = await start();
    strapiLog.level = "error";
    strapiLog.info("export progress");
    strapiLog.warn("skipped file");
    strapiLog.error("export failed");
    expect(lines().map((l) => l.message)).toEqual(["export failed"]);
  });
});
