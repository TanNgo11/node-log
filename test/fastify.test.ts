import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { fastifyLogger } from "../src/fastify";
import { capture } from "./helpers";

async function build() {
  const cap = capture();
  const app = Fastify({ logger: false });
  await app.register(fastifyLogger, { log: cap.log });
  app.get("/orders/:id", async () => {
    await new Promise((r) => setTimeout(r, 1));
    cap.log.info("loading order", { event: "order.loaded" });
    return { ok: true };
  });
  app.get("/boom", async () => {
    throw new Error("db down");
  });
  await app.ready();
  return { app, ...cap };
}

describe("fastify adapter", () => {
  it("logs http.request with route and shares request_id", async () => {
    const { app, lines } = await build();
    const res = await app.inject({ url: "/orders/7?x=1", headers: { "x-request-id": "r-1" } });
    expect(res.headers["x-request-id"]).toBe("r-1");
    const [inner, summary] = lines();
    expect(inner).toMatchObject({ event: "order.loaded", request_id: "r-1" });
    expect(summary).toMatchObject({
      event: "http.request",
      http_route: "/orders/:id",
      http_path: "/orders/7",
      http_status: 200,
      request_id: "r-1",
    });
  });
  it("attaches the error to the 5xx line", async () => {
    const { app, lines } = await build();
    await app.inject({ url: "/boom" });
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ level: "error", http_status: 500, http_route: "/boom", err_message: "db down" });
  });
  it("logs 404 without route", async () => {
    const { app, lines } = await build();
    await app.inject({ url: "/nope" });
    expect(lines()[0]).toMatchObject({ level: "warn", http_status: 404 });
    expect(lines()[0]!.http_route).toBeUndefined();
  });
});

describe("fastify aborted requests", () => {
  it("logs 499 when the client disconnects before the response", async () => {
    const cap = capture();
    const app = Fastify({ logger: false, forceCloseConnections: true });
    await app.register(fastifyLogger, { log: cap.log });
    app.get("/slow", async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { ok: true };
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };
    const ac = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/slow`, { signal: ac.signal }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    await pending;
    await new Promise((r) => setTimeout(r, 400));
    await app.close();
    const summaries = cap.lines().filter((l) => l.event === "http.request");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ http_status: 499, http_route: "/slow" });
  });
});
