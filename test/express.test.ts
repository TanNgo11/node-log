import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { addContext } from "../src/context";
import { errorRecorder, requestLogger } from "../src/express";
import { capture } from "./helpers";

let close: (() => void) | undefined;
afterEach(() => close?.());

async function start(bodyParserFirst = false) {
  const cap = capture();
  const app = express();
  if (bodyParserFirst) app.use(express.json());
  app.use(requestLogger(cap.log));
  if (!bodyParserFirst) app.use(express.json());
  const router = express.Router();
  router.get("/:id", (req, res) => {
    addContext({ user_id: "u1" });
    cap.log.info("loading order", { event: "order.loaded", order_id: req.params.id });
    res.json({ ok: true });
  });
  router.post("/", async (req, res) => {
    await new Promise((r) => setTimeout(r, 1));
    cap.log.info("creating order", { event: "order.create", items_count: req.body.items.length });
    res.status(201).json({});
  });
  app.use("/orders", router);
  app.get("/boom", () => {
    throw new Error("db down");
  });
  app.use(errorRecorder());
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "internal" });
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  close = () => server.close();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { ...cap, base };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("express adapter", () => {
  it("logs one http.request line with route template and shares request_id", async () => {
    const { base, lines } = await start();
    const res = await fetch(`${base}/orders/7?token=x`, { headers: { "x-request-id": "r-1" } });
    expect(res.headers.get("x-request-id")).toBe("r-1");
    await settle();
    const [inner, summary] = lines();
    expect(inner).toMatchObject({ event: "order.loaded", request_id: "r-1", user_id: "u1" });
    expect(summary).toMatchObject({
      level: "info",
      event: "http.request",
      http_method: "GET",
      http_route: "/orders/:id",
      http_path: "/orders/7",
      http_status: 200,
      request_id: "r-1",
      user_id: "u1",
    });
  });
  it.each([false, true])("keeps context through the JSON body parser (parser first: %s)", async (first) => {
    const { base, lines } = await start(first);
    await fetch(`${base}/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"items":[1,2]}' });
    await settle();
    const [inner, summary] = lines();
    expect(inner!.request_id).toBeDefined();
    expect(inner!.request_id).toBe(summary!.request_id);
    expect(summary).toMatchObject({ http_route: "/orders/", http_status: 201 });
  });
  it("puts the error on the single 5xx summary line", async () => {
    const { base, lines } = await start();
    await fetch(`${base}/boom`);
    await settle();
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ level: "error", http_status: 500, http_route: "/boom", err_message: "db down" });
  });
  it("logs unmatched routes without http_route", async () => {
    const { base, lines } = await start();
    await fetch(`${base}/nope`);
    await settle();
    expect(lines()[0]).toMatchObject({ level: "warn", http_status: 404, http_path: "/nope" });
    expect(lines()[0]!.http_route).toBeUndefined();
  });
});
