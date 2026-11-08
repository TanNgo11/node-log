import { globalSingleton } from "./global";
import { defaultRedactor } from "./redact";

export interface ErrFields {
  err_type?: string;
  err_message?: string;
  err_code?: string;
  err_stack?: string;
  err_cause?: string;
  /** Database errors (pg): the table and constraint the server reported. */
  db_table?: string;
  db_constraint?: string;
}

const MAX_CAUSE_DEPTH = 5;

export function isErrorLike(v: unknown): v is Error {
  if (v instanceof Error) return true;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { message?: unknown }).message === "string" &&
    ("stack" in v || "name" in v)
  );
}

function errorType(e: Error): string {
  // pg's DatabaseError keeps the lowercase name "error"; its class name says more.
  if (e.name && e.name !== "Error" && e.name !== "error") return e.name;
  const ctor = (e as { constructor?: { name?: string } }).constructor?.name;
  return ctor && ctor !== "Object" ? ctor : "Error";
}

export function serializeError(err: unknown): ErrFields {
  if (!isErrorLike(err)) {
    if (typeof err === "string") return { err_type: "string", err_message: err };
    return { err_type: typeof err, err_message: defaultRedactor.json(err) };
  }
  const e = err as Error & { code?: unknown; cause?: unknown; table?: unknown; constraint?: unknown };
  const out: ErrFields = { err_type: errorType(e), err_message: String(e.message ?? "") };
  if (e.code !== undefined && e.code !== null) out.err_code = String(e.code);
  if (isSqlState(out.err_code)) {
    out.err_message = stripSql(out.err_message ?? "");
    if (typeof e.table === "string" && e.table) out.db_table = e.table;
    if (typeof e.constraint === "string" && e.constraint) out.db_constraint = e.constraint;
  }
  if (typeof e.stack === "string") out.err_stack = e.stack;

  const causes: string[] = [];
  let cause = e.cause;
  while (cause !== undefined && cause !== null && causes.length < MAX_CAUSE_DEPTH) {
    if (isErrorLike(cause)) {
      causes.push(`${errorType(cause)}: ${cause.message}`);
      cause = (cause as { cause?: unknown }).cause;
    } else {
      causes.push(defaultRedactor.json(cause));
      cause = undefined;
    }
  }
  if (causes.length > 0) out.err_cause = causes.join(" <- ");
  return out;
}

// Postgres SQLSTATE codes: five digits or uppercase letters (23505, 40P01, 25P02).
function isSqlState(code: string | undefined): boolean {
  return code !== undefined && /^[0-9A-Z]{5}$/.test(code);
}

const SQL_START_RE = /^\s*(?:select|insert|update|delete|with|create|alter|drop|truncate|lock)\b/i;

/**
 * knex prefixes a failed query's message with the whole statement ("update ... - deadlock
 * detected"). A long statement filled err_message and the truncation cut off the server's reason,
 * the only part worth reading. Keeps the reason; the statement never reaches the log.
 */
export function stripSql(message: string): string {
  if (!SQL_START_RE.test(message)) return message;
  const at = message.lastIndexOf(" - ");
  return at === -1 ? message : message.slice(at + 3);
}

// The client hung up or sent a malformed request: worth a warn, not an error on our side.
export function isClientDisconnect(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : "";
  return (
    code === "ECONNRESET" ||
    code === "ECONNABORTED" ||
    code === "EPIPE" ||
    code === "ERR_STREAM_PREMATURE_CLOSE" ||
    code.startsWith("HPE_") ||
    e?.message === "aborted"
  );
}

const logged = globalSingleton("logged", () => new WeakSet<object>());

// Marks an error as already written, so a later boundary (e.g. Next's onRequestError)
// does not log it a second time.
export function markLogged(err: unknown): void {
  if (typeof err === "object" && err !== null) logged.add(err);
}

export function isLogged(err: unknown): boolean {
  return typeof err === "object" && err !== null && logged.has(err);
}
