// Redaction shared by the logger and the error serializer. The collector redacts again,
// but it cannot see secrets inside JSON-encoded strings, so the app side must catch them.

export const DEFAULT_REDACT_KEYS = [
  "password", "passwd", "pwd", "passphrase", "secret", "client_secret",
  "token", "access_token", "refresh_token", "id_token", "auth_token",
  "api_key", "apikey", "access_key", "secret_key", "private_key",
  "authorization", "cookie", "set_cookie", "session_id", "sessionid",
  "credential", "credentials", "dsn", "connection_string", "conn_string", "jwt", "bearer",
];

// Keys that only describe a secret (count, type, timestamps, flags) stay readable.
const SAFE_SUFFIXES = ["_count", "_type", "_length", "_expires_at", "_expires_in", "_ttl", "_at", "_ms", "_enabled"];

const REDACTED = "[REDACTED]";

export function toSnakeCase(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .toLowerCase();
}

/** True when any snake_case segment run of `key` names a secret (e.g. stripe_secret_key). */
export function isSensitiveKey(key: string, redactKeys: readonly string[] = DEFAULT_REDACT_KEYS): boolean {
  const k = toSnakeCase(key);
  if (!redactKeys.includes(k) && SAFE_SUFFIXES.some((s) => k.endsWith(s))) return false;
  return redactKeys.some((r) => k === r || k.startsWith(`${r}_`) || k.endsWith(`_${r}`) || k.includes(`_${r}_`));
}

const URL_CREDENTIALS_RE = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"']+:[^\s/@"']+@/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;

/** Masks secrets and emails that appear inside free text. */
export function scrubValue(s: string): string {
  return s
    .replace(URL_CREDENTIALS_RE, `$1${REDACTED}@`)
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(JWT_RE, "[REDACTED_JWT]")
    .replace(EMAIL_RE, "***@$1");
}

/** JSON.stringify that redacts sensitive keys at any depth and never throws. */
export function redactingJson(value: unknown, redactKeys: readonly string[] = DEFAULT_REDACT_KEYS): string {
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value, (key, val: unknown) => {
      if (key && val !== null && val !== undefined && isSensitiveKey(key, redactKeys)) return REDACTED;
      if (typeof val === "bigint") return val.toString();
      if (val instanceof Error) return { name: val.name, message: val.message };
      return val;
    });
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

export { REDACTED };
