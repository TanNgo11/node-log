// Redaction shared by the logger and the error serializer. The collector redacts again,
// but it cannot see secrets inside JSON-encoded strings, so the app side must catch them.

export const DEFAULT_REDACT_KEYS = [
  "password", "passwd", "pwd", "passphrase", "secret", "client_secret",
  "token", "access_token", "refresh_token", "id_token", "auth_token",
  "api_key", "apikey", "access_key", "secret_key", "private_key",
  "authorization", "cookie", "set_cookie", "session_id", "sessionid",
  "credential", "credentials", "dsn", "connection_string", "conn_string", "jwt", "bearer",
];

/** Opt-in value patterns for `redactValues`. Not on by default: they can hit ordinary numbers. */
export const REDACT_PATTERNS = {
  /** Vietnamese mobile numbers: 0912345678, +84912345678, 84912345678. */
  phoneVN: /(?<![\d+])(?:\+?84|0)[35789]\d{8}(?!\d)/g,
  /** Visa, Mastercard, Amex, Discover-like card numbers, with optional spaces or dashes. */
  paymentCard: /(?<!\d)(?:4\d{3}|5[1-5]\d{2}|2[2-7]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))(?:[ -]?\d{4}){2}[ -]?\d{1,4}(?!\d)/g,
  /** IPv4 addresses. */
  ipv4: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g,
} as const;

// Keys that only describe a secret (count, type, timestamps, flags) stay readable.
const SAFE_SUFFIXES = ["_count", "_type", "_length", "_expires_at", "_expires_in", "_ttl", "_at", "_ms", "_enabled"];

export const REDACTED = "[REDACTED]";

export function toSnakeCase(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .toLowerCase();
}

const URL_CREDENTIALS_RE = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"']+:[^\s/@"']+@/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;

export type KeyPattern = string | RegExp;

export interface RedactorOptions {
  /** Extra sensitive keys: names (matched like the defaults) or patterns tested on the snake_case key. */
  keys?: readonly KeyPattern[];
  /** Extra value patterns; every match inside any string becomes [REDACTED]. */
  values?: readonly RegExp[];
}

export interface Redactor {
  isSensitive(key: string): boolean;
  /** Masks secrets and emails that appear inside free text. */
  scrub(s: string): string;
  /** JSON.stringify that redacts sensitive keys at any depth and never throws. */
  json(value: unknown): string;
}

function globalize(re: RegExp): RegExp {
  return re.flags.includes("g") ? new RegExp(re.source, re.flags) : new RegExp(re.source, `${re.flags}g`);
}

export function createRedactor(opts: RedactorOptions = {}): Redactor {
  const words = [...DEFAULT_REDACT_KEYS];
  const keyPatterns: RegExp[] = [];
  for (const k of opts.keys ?? []) {
    if (typeof k === "string") words.push(toSnakeCase(k));
    else keyPatterns.push(new RegExp(k.source, k.flags.replace("g", "")));
  }
  const valuePatterns = (opts.values ?? []).map(globalize);

  const isSensitive = (key: string): boolean => {
    const k = toSnakeCase(key);
    if (keyPatterns.some((re) => re.test(k))) return true;
    if (!words.includes(k) && SAFE_SUFFIXES.some((s) => k.endsWith(s))) return false;
    return words.some((w) => k === w || k.startsWith(`${w}_`) || k.endsWith(`_${w}`) || k.includes(`_${w}_`));
  };

  const scrub = (s: string): string => {
    let out = s
      .replace(URL_CREDENTIALS_RE, `$1${REDACTED}@`)
      .replace(BEARER_RE, `Bearer ${REDACTED}`)
      .replace(JWT_RE, "[REDACTED_JWT]")
      .replace(EMAIL_RE, "***@$1");
    for (const re of valuePatterns) out = out.replace(re, REDACTED);
    return out;
  };

  const json = (value: unknown): string => {
    if (typeof value === "string") return value;
    try {
      const text = JSON.stringify(value, (key, val: unknown) => {
        if (key && val !== null && val !== undefined && isSensitive(key)) return REDACTED;
        if (typeof val === "bigint") return val.toString();
        if (val instanceof Error) return { name: val.name, message: val.message };
        return val;
      });
      return text ?? String(value);
    } catch {
      return String(value);
    }
  };

  return { isSensitive, scrub, json };
}

export const defaultRedactor: Redactor = createRedactor();
