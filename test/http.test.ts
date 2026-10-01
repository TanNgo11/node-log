import { describe, expect, it } from "vitest";
import { withContext } from "../src/context";
import { isLogged } from "../src/error";
import {
  logHttpRequest,
  parseTraceparent,
  propagationHeaders,
  requestContextFields,
  resolveRequestId,
  shouldSkip,
} from "../src/http";
import { capture } from "./helpers";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("request ids", () => {
  it("reuses a valid x-request-id", () => expect(resolveRequestId("abc-123_x.y")).toBe("abc-123_x.y"));
  it("generates a UUID for missing or invalid ids", () => {
    expect(resolveRequestId(undefined)).toMatch(UUID_RE);
    expect(resolveRequestId("has space")).toMatch(UUID_RE);
    expect(resolveRequestId("x".repeat(65))).toMatch(UUID_RE);
  });
  it("parses W3C traceparent", () => {
    expect(parseTraceparent(TP)).toEqual({ trace_id: "4bf92f3577b34da6a3ce929d0e0e4736", span_id: "00f067aa0ba902b7" });
    expect(parseTraceparent("garbage")).toBeUndefined();
    expect(parseTraceparent(`00-${"0".repeat(32)}-00f067aa0ba902b7-01`)).toBeUndefined();
    expect(parseTraceparent(`ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`)).toBeUndefined();
  });
  it("builds context fields from Headers or node headers", () => {
    expect(requestContextFields(new Headers({ "x-request-id": "r1", traceparent: TP }))).toEqual({
      request_id: "r1",
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      span_id: "00f067aa0ba902b7",
    });
    expect(requestContextFields({ "x-request-id": ["r2", "r3"] })).toEqual({ request_id: "r2" });
  });
  it("propagates headers from the current context", async () => {
    expect(propagationHeaders()).toEqual({});
    await withContext({ request_id: "r1", trace_id: "4bf92f3577b34da6a3ce929d0e0e4736", span_id: "00f067aa0ba902b7" }, async () => {
      expect(propagationHeaders()).toEqual({ "x-request-id": "r1", traceparent: TP });
    });
  });
});

describe("logHttpRequest", () => {
  it("picks level from status and builds the summary line", () => {
    const { log, lines } = capture();
    logHttpRequest(log, { method: "POST", route: "/orders/:id", path: "/orders/7?x=1", status: 201, duration_ms: 41.6 });
    logHttpRequest(log, { method: "GET", path: "/missing", status: 404, duration_ms: 2 });
    logHttpRequest(log, { method: "GET", path: "/boom", status: 503, duration_ms: 2 });
    const [ok, notFound, failed] = lines();
    expect(ok).toEqual({
      level: "info",
      message: "POST /orders/:id 201",
      event: "http.request",
      http_method: "POST",
      http_route: "/orders/:id",
      http_path: "/orders/7",
      http_status: 201,
      duration_ms: 42,
    });
    expect(notFound).toMatchObject({ level: "warn", message: "GET /missing 404" });
    expect(notFound!.http_route).toBeUndefined();
    expect(failed!.level).toBe("error");
  });
  it("attaches err fields, drops the stack below 500, and marks the error logged", () => {
    const { log, lines } = capture();
    const e5 = new Error("db down");
    const e4 = new Error("bad input");
    logHttpRequest(log, { method: "GET", path: "/a", status: 500, err: e5 });
    logHttpRequest(log, { method: "GET", path: "/b", status: 400, err: e4 });
    const [l5, l4] = lines();
    expect(l5).toMatchObject({ err_message: "db down" });
    expect(typeof l5!.err_stack).toBe("string");
    expect(l4).toMatchObject({ err_message: "bad input" });
    expect(l4!.err_stack).toBeUndefined();
    expect(isLogged(e5)).toBe(true);
  });
  it("includes context fields passed explicitly", () => {
    const { log, lines } = capture();
    logHttpRequest(log, { method: "GET", path: "/a", status: 200, fields: { request_id: "r1", user_id: "u1" } });
    expect(lines()[0]).toMatchObject({ request_id: "r1", user_id: "u1" });
  });
  it("skips OPTIONS, health checks and static assets", () => {
    expect(shouldSkip("OPTIONS", "/orders")).toBe(true);
    expect(shouldSkip("GET", "/health")).toBe(true);
    expect(shouldSkip("GET", "/healthz?x=1")).toBe(true);
    expect(shouldSkip("GET", "/_next/static/chunks/a.js")).toBe(true);
    expect(shouldSkip("GET", "/favicon.ico")).toBe(true);
    expect(shouldSkip("GET", "/orders")).toBe(false);
    expect(shouldSkip("GET", "/metrics", ["/metrics"])).toBe(true);
    const { log, lines } = capture();
    logHttpRequest(log, { method: "GET", path: "/health", status: 200 });
    expect(lines()).toHaveLength(0);
  });
});
