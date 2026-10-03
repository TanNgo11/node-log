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
