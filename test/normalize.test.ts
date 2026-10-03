import { describe, expect, it } from "vitest";
import {
  buildRecord,
  serializeRecord,
  stripUrl,
  toSnakeCase,
  type NormalizeOptions,
} from "../src/normalize";
import { createRedactor } from "../src/redact";

const opts: NormalizeOptions = { snakeCase: true, redactor: createRedactor() };
const rec = (fields: Record<string, unknown>, message: unknown = "m") =>
  buildRecord("info", message, [fields], opts);

describe("toSnakeCase", () => {
  it.each([
    ["orderId", "order_id"],
    ["HTTPStatus", "http_status"],
    ["x-request-id", "x_request_id"],
    ["already_snake", "already_snake"],
    ["userID2", "user_id2"],
  ])("%s -> %s", (input, out) => expect(toSnakeCase(input)).toBe(out));
});

describe("stripUrl", () => {
  it("drops query, hash and credentials", () => {
    expect(stripUrl("https://u:p@api.x.com/a/b?token=1#h")).toBe("https://api.x.com/a/b");
    expect(stripUrl("/orders?email=a@b.c")).toBe("/orders");
  });
});

describe("buildRecord", () => {
  it("puts level and message first", () => {
    expect(Object.keys(rec({ a: 1 }))).toEqual(["level", "message", "a"]);
  });
  it("merges sources in order, later wins", () => {
    const r = buildRecord("info", "m", [{ a: 1, b: 1 }, undefined, { b: 2 }], opts);
    expect(r).toMatchObject({ a: 1, b: 2 });
  });
  it("flattens plain objects up to 3 levels and stringifies deeper ones", () => {
    const r = rec({ order: { id: "o1", customer: { tier: { name: "gold", extra: { x: 1 } } } } });
    expect(r.order_id).toBe("o1");
    expect(r.order_customer_tier).toBe('{"name":"gold","extra":{"x":1}}');
  });
  it("stringifies arrays, dates, bigints and drops undefined and functions", () => {
    const r = rec({ ids: [1, 2], at: new Date("2026-01-02T03:04:05.000Z"), big: 10n, u: undefined, f: () => 1 });
    expect(r).toMatchObject({ ids: "[1,2]", at: "2026-01-02T03:04:05.000Z", big: "10" });
    expect("u" in r).toBe(false);
    expect("f" in r).toBe(false);
  });
  it("converts non-finite numbers to strings", () => {
    expect(rec({ n: Number.NaN }).n).toBe("NaN");
  });
  it("converts keys to snake_case unless disabled", () => {
    expect(rec({ orderId: "o1" }).order_id).toBe("o1");
    const raw = buildRecord("info", "m", [{ orderId: "o1" }], { ...opts, snakeCase: false });
    expect(raw.orderId).toBe("o1");
  });
  it("prefixes reserved keys with app_", () => {
    const r = rec({ service: "x", version: "1", msg: "y", level: "z", message: "w" });
    expect(r).toMatchObject({ app_service: "x", app_version: "1", app_msg: "y", app_level: "z", app_message: "w" });
    expect(r.level).toBe("info");
    expect(r.message).toBe("m");
  });
  it("redacts sensitive keys at any depth, including suffix matches", () => {
    const r = rec({ password: "p", headers: { authorization: "Bearer x" }, stripeApiKey: "k", token_count: 3 });
    expect(r).toMatchObject({
      password: "[REDACTED]",
      headers_authorization: "[REDACTED]",
      stripe_api_key: "[REDACTED]",
      token_count: 3,
    });
  });
  it("redacts whole objects under a sensitive key", () => {
    expect(rec({ cookie: { a: 1 } }).cookie).toBe("[REDACTED]");
  });
  it("strips query from url fields", () => {
    const r = rec({ http_path: "/a?x=1", http_url: "https://h/b?y=2", callback_url: "https://h/c?z=3" });
    expect(r).toMatchObject({ http_path: "/a", http_url: "https://h/b", callback_url: "https://h/c" });
  });
  it("serializes err into err_* fields", () => {
    const r = rec({ err: new TypeError("bad") });
    expect(r.err_type).toBe("TypeError");
    expect(r.err_message).toBe("bad");
    expect(typeof r.err_stack).toBe("string");
    expect("err" in r).toBe(false);
  });
  it("treats an Error under `error` as err", () => {
    const r = rec({ error: new RangeError("r") });
    expect(r.err_type).toBe("RangeError");
    expect("error" in r).toBe(false);
  });
  it("truncates message, stack and other strings", () => {
    const e = new Error("x");
    e.stack = "s".repeat(5000);
    const r = rec({ big: "b".repeat(2000), err: e }, "m".repeat(600));
    expect((r.message as string).length).toBe(500);
    expect((r.big as string).length).toBe(1000);
    expect((r.err_stack as string).length).toBe(4000);
    expect((r.big as string).endsWith("…[truncated]")).toBe(true);
  });
  it("stringifies non-string messages", () => {
    expect(rec({}, { a: 1 }).message).toBe('{"a":1}');
  });
});

describe("serializeRecord", () => {
  it("returns one JSON line", () => {
    const line = serializeRecord(rec({ a: 1 }));
    expect(line.includes("\n")).toBe(false);
    expect(JSON.parse(line)).toMatchObject({ level: "info", a: 1 });
  });
  it("shrinks records over 16000 bytes to core fields", () => {
    const fields: Record<string, unknown> = { request_id: "r1", event: "e", http_status: 500, err: new Error("boom") };
    for (let i = 0; i < 40; i++) fields[`f${i}`] = "x".repeat(900);
    const out = JSON.parse(serializeRecord(rec(fields)));
    expect(out).toMatchObject({ level: "info", message: "m", request_id: "r1", event: "e", http_status: 500, err_message: "boom", log_truncated: true });
    expect(out.f0).toBeUndefined();
    expect(out.err_stack).toBeUndefined();
  });
});
