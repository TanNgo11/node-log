import { describe, expect, it } from "vitest";
import { parseLevel } from "../src/levels";

describe("parseLevel", () => {
  it("accepts known levels case-insensitively", () => {
    expect(parseLevel("WARN")).toBe("warn");
    expect(parseLevel("fatal")).toBe("fatal");
  });
  it("maps common aliases", () => {
    expect(parseLevel("warning")).toBe("warn");
    expect(parseLevel("err")).toBe("error");
  });
  it("falls back for unknown or missing values", () => {
    expect(parseLevel(undefined)).toBe("info");
    expect(parseLevel("loud", "debug")).toBe("debug");
  });
});
