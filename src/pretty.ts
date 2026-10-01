import type { LogRecord } from "./normalize";

// Human-readable line for local development only (LOG_FORMAT=pretty).
export function formatPretty(record: LogRecord): string {
  const { level, message, err_stack, ...rest } = record;
  const time = new Date().toISOString().slice(11, 23);
  const extras = Object.entries(rest)
    .map(([k, v]) => `${k}=${typeof v === "string" && /\s/.test(v) ? JSON.stringify(v) : String(v)}`)
    .join(" ");
  let line = `${time} ${String(level).toUpperCase().padEnd(5)} ${String(message)}${extras ? ` ${extras}` : ""}`;
  if (typeof err_stack === "string") line += `\n${err_stack}`;
  return line;
}
