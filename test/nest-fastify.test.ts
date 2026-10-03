import "reflect-metadata";
import { Controller, Get, HttpException, Module, Param } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterEach, describe, expect, it } from "vitest";
import { NestLogger, setupNestLogging } from "../src/nest";
import { capture } from "./helpers";

const cap = capture();

@Controller("orders")
class OrdersController {
  @Get("boom")
  boom() {
    throw new Error("db down");
  }
  @Get("teapot")
  teapot() {
    throw new HttpException("short and stout", 418);
  }
  @Get(":id")
  async one(@Param("id") id: string) {
    await new Promise((r) => setTimeout(r, 1));
    cap.log.info("loading order", { event: "order.loaded", order_id: id });
    return { id };
  }
}

@Module({ controllers: [OrdersController] })
class AppModule {}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function start() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: new NestLogger(cap.log),
  });
  await setupNestLogging(app, cap.log);
  await app.listen(0, "127.0.0.1");
  close = () => app.close();
  cap.raw.length = 0; // drop Nest startup lines
  return (await app.getUrl()).replace("[::1]", "127.0.0.1");
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("nest with the Fastify adapter", () => {
  it("logs http.request with the route template and shares request_id", async () => {
    const base = await start();
    const res = await fetch(`${base}/orders/7?token=x`, { headers: { "x-request-id": "r-1" } });
    expect(res.headers.get("x-request-id")).toBe("r-1");
    await settle();
    const [inner, summary] = cap.lines();
    expect(inner).toMatchObject({ event: "order.loaded", request_id: "r-1" });
    expect(summary).toMatchObject({
      event: "http.request",
      http_route: "/orders/:id",
      http_path: "/orders/7",
      http_status: 200,
      request_id: "r-1",
    });
  });
  it("writes exactly one error line for an unhandled exception", async () => {
    const base = await start();
    await fetch(`${base}/orders/boom`);
    await settle();
    const errors = cap.lines().filter((l) => l.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ event: "http.request", http_status: 500, http_route: "/orders/boom", err_message: "db down" });
  });
  it("logs HttpException below 500 as warn without a stack", async () => {
    const base = await start();
    await fetch(`${base}/orders/teapot`);
    await settle();
    const [summary] = cap.lines();
    expect(summary).toMatchObject({ level: "warn", http_status: 418, err_message: "short and stout" });
    expect(summary!.err_stack).toBeUndefined();
  });
});
