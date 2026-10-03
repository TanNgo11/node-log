import "reflect-metadata";
import { Controller, Get, HttpException, Module, Param } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorRecorderInterceptor, NestLogger, requestLogger } from "../src/nest";
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
  one(@Param("id") id: string) {
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
  const app = await NestFactory.create(AppModule, { logger: new NestLogger(cap.log) });
  app.use(requestLogger(cap.log));
  app.useGlobalInterceptors(new ErrorRecorderInterceptor());
  await app.listen(0, "127.0.0.1");
  close = () => app.close();
  cap.raw.length = 0; // drop Nest startup lines
  return (await app.getUrl()).replace("[::1]", "127.0.0.1");
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("nest adapter", () => {
  it("logs http.request with the Nest route and request_id", async () => {
    const base = await start();
    await fetch(`${base}/orders/7`, { headers: { "x-request-id": "r-1" } });
    await settle();
    const [inner, summary] = cap.lines();
    expect(inner).toMatchObject({ event: "order.loaded", request_id: "r-1" });
    expect(summary).toMatchObject({ event: "http.request", http_route: "/orders/:id", http_status: 200, request_id: "r-1" });
  });
  it("writes exactly one error line for an unhandled exception", async () => {
    const base = await start();
    await fetch(`${base}/orders/boom`);
    await settle();
    const errors = cap.lines().filter((l) => l.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ event: "http.request", http_status: 500, err_message: "db down" });
  });
  it("logs HttpException below 500 as warn without a stack", async () => {
    const base = await start();
    await fetch(`${base}/orders/teapot`);
    await settle();
    const [summary] = cap.lines();
    expect(summary).toMatchObject({ level: "warn", http_status: 418, err_message: "short and stout" });
    expect(summary!.err_stack).toBeUndefined();
  });
  it("maps Nest internal logs to JSON with nest_context", () => {
    cap.raw.length = 0;
    const nl = new NestLogger(cap.log);
    nl.log("Mapped {/orders, GET} route", "RouterExplorer");
    nl.error("Something failed", "Error: x\n    at foo (a.js:1:1)", "SomeService");
    nl.verbose("v");
    expect(cap.lines()).toMatchObject([
      { level: "info", message: "Mapped {/orders, GET} route", nest_context: "RouterExplorer" },
      { level: "error", message: "Something failed", nest_context: "SomeService", err_stack: "Error: x\n    at foo (a.js:1:1)" },
      { level: "trace", message: "v" },
    ]);
  });
});

describe("NestLogger extra arguments", () => {
  it("keeps object and primitive arguments as fields", () => {
    cap.raw.length = 0;
    const nl = new NestLogger(cap.log);
    nl.log("order created", { orderId: 42 }, "OrdersService");
    nl.warn("retrying", 3);
    expect(cap.lines()).toMatchObject([
      { level: "info", message: "order created", order_id: 42, nest_context: "OrdersService" },
      { level: "warn", message: "retrying", nest_args: "[3]" },
    ]);
  });
});
