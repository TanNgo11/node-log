import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { isClientDisconnect, serializeError, stripSql } from "../src/error";
import { logHttpRequest } from "../src/http";
import { knexLogging, tableOf } from "../src/knex";
import { REDACT_PATTERNS } from "../src/redact";
import { capture } from "./helpers";

describe("phoneVN boundaries", () => {
  it("still masks phone numbers in text", () => {
    const { log, lines } = capture({ redactValues: [REDACT_PATTERNS.phoneVN] });
    log.info("goi 0912345678, +84987654321 hoac (0388888888).");
    expect(lines()[0]!.message).toBe("goi [REDACTED], [REDACTED] hoac ([REDACTED]).");
  });

  it("leaves a hex id segment alone", () => {
    const { log, lines } = capture({ redactValues: [REDACT_PATTERNS.phoneVN] });
    const id = "d1a9162b-f872-4266-98b4-0912345678e0";
    log.info(`requestId=${id}`, { note: `ref ${id}`, hash: "ab0912345678" });
    expect(lines()[0]).toMatchObject({ message: `requestId=${id}`, note: `ref ${id}`, hash: "ab0912345678" });
  });

  it("never scrubs well-formed correlation ids", () => {
    const { log, lines } = capture({ redactValues: [/\d{4}/g] });
    log.info("m", { request_id: "abcd-1234-ef", upstream_request_id: "5678-x", trace_id: "99999", note: "1234" });
    expect(lines()[0]).toMatchObject({
      request_id: "abcd-1234-ef",
      upstream_request_id: "5678-x",
      trace_id: "99999",
      note: "[REDACTED]",
    });
  });

  it("scrubs an id field that is not a plain token", () => {
    const { log, lines } = capture();
    log.info("m", { request_id: "x Bearer abc.def" });
    expect(lines()[0]!.request_id).toBe("x Bearer [REDACTED]");
  });
});

class DatabaseError extends Error {
  code = "25P02";
  table = "properties";
  constraint = "properties_slug_unique";
  constructor(message: string) {
    super(message);
    this.name = "error";
  }
}

describe("database errors", () => {
  it("drops the statement knex prefixed and keeps the server's reason", () => {
    const sql = `update "public"."properties" set "title" = $1, ${"\"x\" = $2, ".repeat(80)}"id" = $3`;
    const out = serializeError(new DatabaseError(`${sql} - current transaction is aborted, commands ignored until end of transaction block`));
    expect(out).toMatchObject({
      err_type: "DatabaseError",
      err_code: "25P02",
      err_message: "current transaction is aborted, commands ignored until end of transaction block",
      db_table: "properties",
      db_constraint: "properties_slug_unique",
    });
  });

  it("keeps messages that are not statements", () => {
    expect(stripSql("duplicate key - see detail")).toBe("duplicate key - see detail");
    expect(stripSql("select 1 - deadlock detected")).toBe("deadlock detected");
  });

  it("does not touch non-SQLSTATE codes", () => {
    const e = Object.assign(new Error("select failed - x"), { code: "ECONNREFUSED" });
    expect(serializeError(e).err_message).toBe("select failed - x");
  });
});

describe("client disconnects on http.request", () => {
  it("logs an aborted request as warn with client_disconnect", () => {
    const { log, lines } = capture();
    const err = new Error("aborted");
    expect(isClientDisconnect(err)).toBe(true);
    logHttpRequest(log, { method: "GET", route: "/api/x", path: "/api/x", status: 500, err });
    expect(lines()[0]).toMatchObject({ level: "warn", http_status: 500, err_message: "aborted", client_disconnect: true });
    expect(lines()[0]!.err_stack).toBeUndefined();
  });

  it("keeps a real 500 at error", () => {
    const { log, lines } = capture();
    logHttpRequest(log, { method: "GET", path: "/x", status: 500, err: new Error("boom") });
    expect(lines()[0]).toMatchObject({ level: "error" });
    expect(lines()[0]!.client_disconnect).toBeUndefined();
  });
});

describe("knexLogging", () => {
  function setup(opts: Parameters<typeof knexLogging>[2] = {}) {
    const knex = new EventEmitter();
    const { log, lines } = capture();
    let t = 0;
    knexLogging(knex, log, { now: () => t, db_system: "postgres", ...opts });
    return { knex, lines, advance: (ms: number) => (t += ms) };
  }

  it("names the table without schema or quotes", () => {
    expect(tableOf('update "public"."properties" set "a" = $1')).toBe("properties");
    expect(tableOf("select * from users where id = $1")).toBe("users");
    expect(tableOf('insert into "logs" ("a") values ($1)')).toBe("logs");
    expect(tableOf("begin")).toBeUndefined();
  });

  it("logs a slow query without SQL text or bindings", () => {
    const { knex, lines, advance } = setup();
    const data = { __knexQueryUid: "q1", method: "select", sql: 'select * from "properties" where "phone" = ?', bindings: ["0912345678"] };
    knex.emit("query", data);
    advance(750);
    knex.emit("query-response", [{}, {}], data);
    knex.emit("query", { __knexQueryUid: "q2", method: "select", sql: "select 1" });
    knex.emit("query-response", [], { __knexQueryUid: "q2" });
    expect(lines()).toEqual([
      {
        level: "warn",
        message: "slow query",
        event: "db.slow_query",
        db_system: "postgres",
        db_operation: "select",
        db_table: "properties",
        duration_ms: 750,
        db_rows: 2,
      },
    ]);
  });

  it("logs failed queries only when asked, never 25P02", () => {
    const quiet = setup();
    quiet.knex.emit("query-error", Object.assign(new Error("x"), { code: "40P01" }), { __knexQueryUid: "a" });
    expect(quiet.lines()).toEqual([]);

    const { knex, lines } = setup({ logErrors: true });
    const data = { __knexQueryUid: "q", method: "update", sql: 'update "properties" set "a" = $1' };
    knex.emit("query", data);
    knex.emit("query-error", Object.assign(new Error('update "properties" set "a" = $1 - deadlock detected'), { code: "40P01" }), data);
    knex.emit("query-error", Object.assign(new Error("aborted tx"), { code: "25P02" }), data);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({
      level: "warn",
      event: "db.error",
      db_operation: "update",
      db_table: "properties",
      err_code: "40P01",
      err_message: "deadlock detected",
    });
  });

  it("honours errorLevel and ignoreCodes", () => {
    const { knex, lines } = setup({ logErrors: true, errorLevel: "error", ignoreCodes: ["23505"] });
    knex.emit("query-error", Object.assign(new Error("dup"), { code: "23505" }), { __knexQueryUid: "a" });
    knex.emit("query-error", Object.assign(new Error("deadlock detected"), { code: "40P01" }), { __knexQueryUid: "b" });
    expect(lines().map((l) => [l.level, l.err_code])).toEqual([["error", "40P01"]]);
  });
});
