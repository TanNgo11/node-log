import { globalSingleton } from "./global";

export interface ErrFields {
  err_type?: string;
  err_message?: string;
  err_code?: string;
  err_stack?: string;
  err_cause?: string;
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

export function safeString(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    const json = JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val));
    return json ?? String(v);
  } catch {
    return String(v);
  }
}

function errorType(e: Error): string {
  if (e.name && e.name !== "Error") return e.name;
  const ctor = (e as { constructor?: { name?: string } }).constructor?.name;
  return ctor && ctor !== "Object" ? ctor : "Error";
}

export function serializeError(err: unknown): ErrFields {
  if (!isErrorLike(err)) {
    if (typeof err === "string") return { err_type: "string", err_message: err };
    return { err_type: typeof err, err_message: safeString(err) };
  }
  const e = err as Error & { code?: unknown; cause?: unknown };
  const out: ErrFields = { err_type: errorType(e), err_message: String(e.message ?? "") };
  if (e.code !== undefined && e.code !== null) out.err_code = String(e.code);
  if (typeof e.stack === "string") out.err_stack = e.stack;

  const causes: string[] = [];
  let cause = e.cause;
  while (cause !== undefined && cause !== null && causes.length < MAX_CAUSE_DEPTH) {
    if (isErrorLike(cause)) {
      causes.push(`${errorType(cause)}: ${cause.message}`);
      cause = (cause as { cause?: unknown }).cause;
    } else {
      causes.push(safeString(cause));
      cause = undefined;
    }
  }
  if (causes.length > 0) out.err_cause = causes.join(" <- ");
  return out;
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
