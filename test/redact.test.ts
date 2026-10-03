import { describe, expect, it } from "vitest";
import { serializeError } from "../src/error";
import { capture } from "./helpers";

const line = (fields: Record<string, unknown>, message = "m", options = {}) => {
  const { log, lines } = capture(options);
  log.info(message, fields);
  return lines()[0]!;
};

describe("key redaction", () => {
  it.each([
    "connectionString",
    "dsn",
    "stripeSecretKey",
    "awsSecretAccessKey",
    "privateKeyPem",
    "jwt",
    "passphrase",
    "credentials",
    "sessionId",
    "x-api-key",
    "idToken",
  ])("redacts %s", (key) => {
    const out = line({ [key]: "s3cr3t-value" });
    expect(JSON.stringify(out)).not.toContain("s3cr3t-value");
  });

  it.each(["token_count", "token_type", "password_reset_at", "api_key_enabled", "session_count"])(
    "keeps harmless %s",
    (key) => {
      expect(line({ [key]: 3 })).toMatchObject({ [key]: 3 });
    },
  );

  it("redacts inside arrays and objects deeper than the flatten limit", () => {
    const out = line({ users: [{ password: "hunter2" }], deep: { a: { b: { token: "t0k" } } } });
    const text = JSON.stringify(out);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("t0k");
    expect(text).toContain("[REDACTED]");
  });

  it("redacts camelCase keys even when snakeCase is off", () => {
    const out = line({ accessToken: "a1", Authorization: "Bearer b2", headers: { Cookie: "c3" } }, "m", { snakeCase: false });
    expect(JSON.stringify(out)).not.toMatch(/a1|b2|c3/);
  });

  it("redacts sensitive keys inside non-error values passed as err", () => {
    const out = serializeError({ code: "E1", password: "hunter2" });
    expect(out.err_message).not.toContain("hunter2");
  });
});

describe("value scrubbing", () => {
  it("masks credentials, bearer tokens, JWTs and emails in any string", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
    const out = line(
      { note: `db postgres://app:pa55@db:5432/x, auth Bearer abc.def, jwt ${jwt}, user john.doe@example.com` },
      "login failed for jane@corp.vn",
    );
    expect(out.note).toBe("db postgres://[REDACTED]@db:5432/x, auth Bearer [REDACTED], jwt [REDACTED_JWT], user ***@example.com");
    expect(out.message).toBe("login failed for ***@corp.vn");
  });
});
