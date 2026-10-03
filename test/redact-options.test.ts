import { describe, expect, it } from "vitest";
import { REDACT_PATTERNS } from "../src/redact";
import { capture } from "./helpers";

describe("custom redaction", () => {
  it("accepts RegExp key patterns, matched against the snake_case key", () => {
    const { log, lines } = capture({ redactKeys: [/^national_id/, "tax_code"] });
    log.info("m", { nationalIdNumber: "079123456789", taxCode: "0312345678", list: [{ national_id: "x1" }] });
    expect(lines()[0]).toMatchObject({ national_id_number: "[REDACTED]", tax_code: "[REDACTED]", list: '[{"national_id":"[REDACTED]"}]' });
  });

  it("masks custom value patterns in every string, including the message", () => {
    const { log, lines } = capture({ redactValues: [REDACT_PATTERNS.phoneVN, REDACT_PATTERNS.paymentCard] });
    log.info("call 0912345678 now", { note: "card 4111 1111 1111 1111, alt +84987654321", at_ms: 1727000000000 });
    expect(lines()[0]).toMatchObject({
      message: "call [REDACTED] now",
      note: "card [REDACTED], alt [REDACTED]",
      at_ms: 1727000000000,
    });
  });

  it("runs a final hook per field: replace, keep, or drop with undefined", () => {
    const { log, lines } = capture({
      redact: (key, value) => {
        if (key === "internal_note") return undefined;
        if (key === "customer_name" && typeof value === "string") return value.slice(0, 1) + "***";
        return value;
      },
    });
    log.info("m", { customerName: "Nguyen", internalNote: "secret plan", ok: true });
    const out = lines()[0]!;
    expect(out).toMatchObject({ customer_name: "N***", ok: true, level: "info", message: "m" });
    expect("internal_note" in out).toBe(false);
  });

  it("does not let the hook remove level, message or event", () => {
    const { log, lines } = capture({ redact: () => undefined });
    log.warn("m", { event: "x.y", a: 1 });
    expect(lines()[0]).toEqual({ level: "warn", message: "m", event: "x.y" });
  });

  it("keeps logging when the hook throws", () => {
    const { log, lines } = capture({
      redact: () => {
        throw new Error("bad hook");
      },
    });
    log.info("m", { a: 1 });
    expect(lines()[0]).toMatchObject({ level: "error", event: "log.serialize_failed" });
  });

  it("leaves 13-digit timestamps alone with the built-in card pattern", () => {
    expect("1727000000000".replace(REDACT_PATTERNS.paymentCard, "X")).toBe("1727000000000");
  });
});
