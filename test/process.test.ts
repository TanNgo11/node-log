import { afterEach, describe, expect, it, vi } from "vitest";
import { crashHandlers, installProcessHandlers, logShutdown, logStartup } from "../src/process";
import { capture } from "./helpers";

afterEach(() => {
  vi.useRealTimers();
});

describe("logStartup / logShutdown", () => {
  it("logs app.started with runtime and level", () => {
    const { log, lines } = capture({ level: "info" });
    logStartup(log, { port: 3000 });
    expect(lines()[0]).toEqual({
      level: "info",
      message: "app started",
      event: "app.started",
      runtime_version: `node ${process.versions.node}`,
      log_level: "info",
      port: 3000,
    });
  });
  it("logs app.stopping when the app starts its own shutdown", () => {
    const { log, lines } = capture();
    logShutdown(log, { signal: "SIGTERM" });
    expect(lines()[0]).toMatchObject({ level: "info", event: "app.stopping", message: "app stopping", signal: "SIGTERM" });
  });
});

describe("crashHandlers", () => {
  it("logs app.crashed as fatal and exits only after a delay, so other handlers can run", () => {
    vi.useFakeTimers();
    const { log, lines } = capture();
    const exit = vi.fn();
    const h = crashHandlers(log, { exit, exitDelayMs: 500 });
    h.onUncaught(new Error("boom"));
    h.onRejection("nope");
    expect(lines()).toMatchObject([
      { level: "fatal", event: "app.crashed", crash_source: "uncaughtException", err_message: "boom" },
      { level: "fatal", event: "app.crashed", crash_source: "unhandledRejection", err_message: "nope" },
    ]);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(exit).toHaveBeenCalledWith(1);
  });
  it("logs app.unhandled_error as error without exiting when exitOnCrash is false", () => {
    vi.useFakeTimers();
    const { log, lines } = capture();
    const exit = vi.fn();
    crashHandlers(log, { exit, exitOnCrash: false }).onRejection(new Error("x"));
    vi.runAllTimers();
    expect(lines()[0]).toMatchObject({ level: "error", event: "app.unhandled_error" });
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("installProcessHandlers", () => {
  it("never registers signal listeners, so the app keeps control of shutdown", () => {
    const before = { term: process.listenerCount("SIGTERM"), int: process.listenerCount("SIGINT") };
    const uncaughtBefore = process.listeners("uncaughtException");
    const rejectionBefore = process.listeners("unhandledRejection");
    const { log } = capture();
    installProcessHandlers(log);
    expect(process.listenerCount("SIGTERM")).toBe(before.term);
    expect(process.listenerCount("SIGINT")).toBe(before.int);
    for (const l of process.listeners("uncaughtException")) if (!uncaughtBefore.includes(l)) process.off("uncaughtException", l);
    for (const l of process.listeners("unhandledRejection")) if (!rejectionBefore.includes(l)) process.off("unhandledRejection", l);
  });
});

describe("logProcessWarnings", () => {
  it("logs Node process warnings as process.warning with the emit-site stack", async () => {
    const { logProcessWarnings } = await import("../src/process");
    const { log, lines } = capture();
    const before = process.listeners("warning");
    logProcessWarnings(log);
    const warning = Object.assign(new Error("Calling client.query() when the client is already executing a query is deprecated"), {
      name: "DeprecationWarning",
      code: "DEP_PG_QUERY",
    });
    process.emit("warning", warning);
    for (const l of process.listeners("warning")) if (!before.includes(l)) process.off("warning", l);
    expect(lines()[0]).toMatchObject({
      level: "warn",
      event: "process.warning",
      message: "process warning",
      err_type: "DeprecationWarning",
      err_code: "DEP_PG_QUERY",
    });
    expect(typeof lines()[0]!.err_stack).toBe("string");
  });
  it("installs its listener only once", async () => {
    const { logProcessWarnings } = await import("../src/process");
    const { log } = capture();
    const before = process.listenerCount("warning");
    logProcessWarnings(log);
    logProcessWarnings(log);
    expect(process.listenerCount("warning")).toBeLessThanOrEqual(before + 1);
  });
});

describe("logProcessWarnings stack depth", () => {
  it("raises Error.stackTraceLimit so app frames survive deep framework stacks", async () => {
    const { raiseStackTraceLimit } = await import("../src/process");
    const original = Error.stackTraceLimit;
    try {
      Error.stackTraceLimit = 10;
      raiseStackTraceLimit(30);
      expect(Error.stackTraceLimit).toBe(30);
      Error.stackTraceLimit = 50;
      raiseStackTraceLimit(30);
      expect(Error.stackTraceLimit).toBe(50);
    } finally {
      Error.stackTraceLimit = original;
    }
  });
});

describe("logProcessWarnings defaults", () => {
  it("removes Node's stderr printer and throttles repeats, keeping their count", async () => {
    const { logProcessWarnings } = await import("../src/process");
    const state = (globalThis as Record<symbol, { installed: boolean }>)[Symbol.for("@tanngo11/log.warnings")];
    if (state) state.installed = false;
    const before = process.listeners("warning");
    const printer = function onWarning() {};
    process.on("warning", printer);
    const { log, lines } = capture();
    let clock = 0;
    logProcessWarnings(log, { repeatWindowMs: 1000, now: () => clock });
    expect(process.listeners("warning")).not.toContain(printer);
    const emit = (message: string) => process.emit("warning", Object.assign(new Error(message), { name: "DeprecationWarning" }));
    emit("pg query while executing");
    emit("pg query while executing");
    emit("pg query while executing");
    emit("other deprecation");
    clock = 1000;
    emit("pg query while executing");
    for (const l of process.listeners("warning")) if (!before.includes(l)) process.off("warning", l);
    expect(lines().map((l) => [l.err_message, l.suppressed_count])).toEqual([
      ["pg query while executing", undefined],
      ["other deprecation", undefined],
      ["pg query while executing", 2],
    ]);
  });
});
