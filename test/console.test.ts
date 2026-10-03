import { afterEach, describe, expect, it } from "vitest";
import { withContext } from "../src/context";
import { patchConsole } from "../src/console";
import { capture } from "./helpers";

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe("patchConsole", () => {
  it("turns console calls into JSON lines with level, event and context", async () => {
    const { log, lines } = capture();
    restore = patchConsole(log);
    await withContext({ request_id: "r1" }, async () => {
      console.log("user", { id: 7, password: "x" }, 3);
      console.warn("slow");
      console.error("failed to save", new TypeError("bad"));
      console.debug("dbg");
    });
    restore();
    restore = undefined;
    const out = lines();
    expect(out[0]).toMatchObject({ level: "info", event: "console", console_method: "log", message: 'user {"id":7,"password":"[REDACTED]"} 3', request_id: "r1" });
    expect(out[1]).toMatchObject({ level: "warn", event: "console", message: "slow" });
    expect(out[2]).toMatchObject({ level: "error", message: "failed to save bad", err_type: "TypeError", err_message: "bad" });
    expect(out[3]).toMatchObject({ level: "debug", message: "dbg" });
  });
  it("restores the original console and is safe to call twice", () => {
    const original = console.log;
    const { log } = capture();
    const r1 = patchConsole(log);
    const r2 = patchConsole(log);
    expect(console.log).not.toBe(original);
    r2();
    r1();
    expect(console.log).toBe(original);
  });
});
