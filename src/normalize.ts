import { isErrorLike, safeString, serializeError } from "./error";
import type { Level } from "./levels";

export type Fields = Record<string, unknown>;
export type Primitive = string | number | boolean | null;
export type LogRecord = Record<string, Primitive>;

export interface NormalizeOptions {
  snakeCase: boolean;
  redactKeys: string[];
}

export const DEFAULT_REDACT_KEYS = [
  "password", "passwd", "pwd", "secret", "client_secret", "token", "access_token", "refresh_token",
  "api_key", "apikey", "authorization", "cookie", "set_cookie", "private_key",
];

// Keys owned by Vector (overwritten or deleted on ingest) or by the logger itself.
export const RESERVED_KEYS = new Set([
  "project", "service", "vps", "version", "container_name", "container_id", "image", "stream",
  "_timestamp", "label", "host", "source_type", "msg", "lvl", "severity", "level", "message",
]);

export const MAX_LINE_BYTES = 16000;
const MAX_MESSAGE = 500;
const MAX_STACK = 4000;
const MAX_STRING = 1000;
const MAX_DEPTH = 3;
const TRUNCATED = "…[truncated]";
const REDACTED = "[REDACTED]";

// Fields kept when a line is too large.
const KEEP_ON_SHRINK = new Set([
  "level", "message", "event", "request_id", "trace_id", "span_id", "job_name", "job_id", "job_attempt",
  "user_id", "tenant_id", "err_type", "err_message", "err_code",
]);

export function toSnakeCase(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .toLowerCase();
}

export function stripUrl(url: string): string {
  const noQuery = url.split(/[?#]/, 1)[0] ?? "";
  return noQuery.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, "$1");
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - TRUNCATED.length) + TRUNCATED : s;
}

function isPlainObject(v: unknown): v is Fields {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isSensitive(key: string, redactKeys: string[]): boolean {
  return redactKeys.some((k) => key === k || key.endsWith(`_${k}`));
}

function isUrlKey(key: string): boolean {
  return key === "http_path" || key === "http_url" || key.endsWith("_url");
}

function flattenInto(out: LogRecord, prefix: string, obj: Fields, depth: number, opts: NormalizeOptions): void {
  for (const [rawKey, value] of Object.entries(obj)) {
    const key = opts.snakeCase ? toSnakeCase(rawKey) : rawKey;
    const full = prefix ? `${prefix}_${key}` : key;
    if (value === undefined || typeof value === "function" || typeof value === "symbol") continue;
    if (value !== null && (isSensitive(key, opts.redactKeys) || isSensitive(full, opts.redactKeys))) {
      out[full] = REDACTED;
      continue;
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      out[full] = value;
    } else if (typeof value === "number") {
      out[full] = Number.isFinite(value) ? value : String(value);
    } else if (typeof value === "bigint") {
      out[full] = value.toString();
    } else if (value instanceof Date) {
      out[full] = Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
    } else if (isErrorLike(value)) {
      out[full] = `${value.name}: ${value.message}`;
    } else if (isPlainObject(value) && depth < MAX_DEPTH - 1) {
      flattenInto(out, full, value, depth + 1, opts);
    } else {
      out[full] = safeString(value);
    }
  }
}

function finalize(key: string, value: Primitive): Primitive {
  if (typeof value !== "string") return value;
  const v = isUrlKey(key) ? stripUrl(value) : value;
  return truncate(v, key === "err_stack" ? MAX_STACK : MAX_STRING);
}

export function buildRecord(
  level: Level,
  message: unknown,
  sources: (Fields | undefined)[],
  opts: NormalizeOptions,
): LogRecord {
  const merged: Fields = {};
  for (const source of sources) if (source) Object.assign(merged, source);

  let err: unknown;
  if (merged.err !== undefined && merged.err !== null) {
    err = merged.err;
    delete merged.err;
  } else if (isErrorLike(merged.error)) {
    err = merged.error;
    delete merged.error;
  }

  const flat: LogRecord = {};
  flattenInto(flat, "", merged, 0, opts);
  if (err !== undefined) Object.assign(flat, serializeError(err));

  const out: LogRecord = {
    level,
    message: truncate(typeof message === "string" ? message : safeString(message), MAX_MESSAGE),
  };
  for (const [k, v] of Object.entries(flat)) {
    const key = RESERVED_KEYS.has(k) ? `app_${k}` : k;
    out[key] = finalize(key, v);
  }
  return out;
}

function byteLength(s: string): number {
  // UTF-8 uses at most 3 bytes per UTF-16 code unit: skip encoding short lines.
  if (s.length * 3 <= MAX_LINE_BYTES) return s.length;
  return new TextEncoder().encode(s).length;
}

export function serializeRecord(record: LogRecord): string {
  const line = JSON.stringify(record);
  if (byteLength(line) <= MAX_LINE_BYTES) return line;
  const small: LogRecord = {};
  for (const [k, v] of Object.entries(record)) {
    if (KEEP_ON_SHRINK.has(k) || k.startsWith("http_")) small[k] = v;
  }
  small.log_truncated = true;
  return JSON.stringify(small);
}
