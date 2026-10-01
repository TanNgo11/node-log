import { describe, expect, it } from "vitest";
import { isLogged, markLogged, serializeError } from "../src/error";

class DbError extends Error {
  code = 23505;
}

describe("serializeError", () => {
  it("extracts type, message, code and stack", () => {
    const out = serializeError(new DbError("duplicate key"));
    expect(out.err_type).toBe("DbError");
    expect(out.err_message).toBe("duplicate key");
    expect(out.err_code).toBe("23505");
    expect(out.err_stack).toContain("duplicate key");
  });
  it("uses the name property when set", () => {
    const e = new Error("x");
    e.name = "PrismaClientKnownRequestError";
    expect(serializeError(e).err_type).toBe("PrismaClientKnownRequestError");
  });
  it("joins the cause chain with ' <- ' up to 5 levels", () => {
    let e: Error = new Error("root");
    for (let i = 1; i <= 7; i++) e = new Error(`level ${i}`, { cause: e });
    const out = serializeError(e);
    expect(out.err_message).toBe("level 7");
    expect(out.err_cause!.split(" <- ")).toHaveLength(5);
    expect(out.err_cause!.startsWith("Error: level 6")).toBe(true);
  });
  it("handles non-error values", () => {
    expect(serializeError("boom")).toEqual({ err_type: "string", err_message: "boom" });
    expect(serializeError({ a: 1 })).toEqual({ err_type: "object", err_message: '{"a":1}' });
  });
  it("tracks errors already logged", () => {
    const e = new Error("x");
    expect(isLogged(e)).toBe(false);
    markLogged(e);
    expect(isLogged(e)).toBe(true);
    expect(isLogged("str")).toBe(false);
  });
});
