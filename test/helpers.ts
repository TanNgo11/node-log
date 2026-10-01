import { createLogger, type LoggerOptions } from "../src/logger";

export function capture(options: LoggerOptions = {}) {
  const raw: string[] = [];
  const log = createLogger({ level: "trace", ...options, write: (line) => raw.push(line) });
  return {
    log,
    raw,
    lines: () => raw.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}
