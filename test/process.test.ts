import { describe, expect, it, vi } from "vitest";
import { crashHandlers, logStartup } from "../src/process";
import { capture } from "./helpers";

describe("logStartup", () => {
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
});

describe("crashHandlers", () => {
  it("logs app.crashed as fatal and exits by default", () => {
    const { log, lines } = capture();
    const exit = vi.fn();
    const h = crashHandlers(log, { exit });
    h.onUncaught(new Error("boom"));
    h.onRejection("nope");
    expect(lines()).toMatchObject([
      { level: "fatal", event: "app.crashed", crash_source: "uncaughtException", err_message: "boom" },
      { level: "fatal", event: "app.crashed", crash_source: "unhandledRejection", err_message: "nope" },
    ]);
    expect(exit).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenCalledWith(1);
  });
  it("logs app.unhandled_error as error without exiting when exitOnCrash is false", () => {
    const { log, lines } = capture();
    const exit = vi.fn();
    crashHandlers(log, { exit, exitOnCrash: false }).onRejection(new Error("x"));
    expect(lines()[0]).toMatchObject({ level: "error", event: "app.unhandled_error" });
    expect(exit).not.toHaveBeenCalled();
  });
  it("logs app.stopping on signals", () => {
    const { log, lines } = capture();
    crashHandlers(log).onSignal("SIGTERM");
    expect(lines()[0]).toMatchObject({ level: "info", event: "app.stopping", signal: "SIGTERM" });
  });
});
