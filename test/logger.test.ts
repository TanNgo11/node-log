import { describe, expect, it } from "vitest";
import { withContext } from "../src/context";
import { createLogger } from "../src/logger";
import { capture } from "./helpers";

describe("createLogger", () => {
  it("writes one JSON line per call with level and message", () => {
    const { log, lines } = capture();
    log.info("order created", { event: "order.created", order_id: "o1" });
    expect(lines()).toEqual([{ level: "info", message: "order created", event: "order.created", order_id: "o1" }]);
  });
  it("filters below the configured level", () => {
    const { log, lines } = capture({ level: "warn" });
    log.info("skip");
    log.warn("keep");
    expect(lines().map((l) => l.message)).toEqual(["keep"]);
    expect(log.isLevelEnabled("info")).toBe(false);
  });
  it("reads LOG_LEVEL when no level option is given", () => {
    process.env.LOG_LEVEL = "error";
    const raw: string[] = [];
    const log = createLogger({ write: (l) => raw.push(l) });
    delete process.env.LOG_LEVEL;
    log.warn("skip");
    expect(raw).toHaveLength(0);
    expect(log.level).toBe("error");
  });
  it("merges base, context, child and call fields in that order", async () => {
    const { log, lines } = capture({ base: { a: "base", b: "base", c: "base", d: "base" } });
    await withContext({ b: "ctx", c: "ctx", d: "ctx" }, async () => {
      log.child({ c: "child", d: "child" }).info("m", { d: "call" });
    });
    expect(lines()[0]).toMatchObject({ a: "base", b: "ctx", c: "child", d: "call" });
  });
  it("adds custom redact keys", () => {
    const { log, lines } = capture({ redactKeys: ["nationalId"] });
    log.info("m", { national_id: "123" });
    expect(lines()[0]!.national_id).toBe("[REDACTED]");
  });
  it("never throws, even when serialization or writing fails", () => {
    const raw: string[] = [];
    const log = createLogger({ level: "trace", write: (l) => raw.push(l) });
    const evil = {
      get boom() {
        throw new Error("getter");
      },
    };
    expect(() => log.info("m", evil)).not.toThrow();
    expect(JSON.parse(raw[0]!)).toMatchObject({ level: "error", event: "log.serialize_failed" });
    const failing = createLogger({
      write: () => {
        throw new Error("EPIPE");
      },
    });
    expect(() => failing.error("m")).not.toThrow();
  });
  it("supports pretty format", () => {
    const raw: string[] = [];
    const log = createLogger({ format: "pretty", write: (l) => raw.push(l) });
    log.warn("slow query", { duration_ms: 812, db_table: "orders" });
    expect(raw[0]).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} WARN  slow query duration_ms=812 db_table=orders$/);
  });
});
