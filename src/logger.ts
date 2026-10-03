import { getContext } from "./context";
import { LEVEL_RANK, parseLevel, type Level } from "./levels";
import {
  buildRecord,
  DEFAULT_REDACT_KEYS,
  serializeRecord,
  toSnakeCase,
  type Fields,
  type NormalizeOptions,
} from "./normalize";
import { formatPretty } from "./pretty";

type LogMethod = (message: string, fields?: Fields) => void;

export interface Logger {
  readonly level: Level;
  trace: LogMethod;
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  fatal: LogMethod;
  child(fields: Fields): Logger;
  isLevelEnabled(level: Level): boolean;
}

export interface LoggerOptions {
  level?: Level | string;
  format?: "json" | "pretty";
  base?: Fields;
  redactKeys?: string[];
  snakeCase?: boolean;
  write?: (line: string) => void;
}

function env(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env?.[name] : undefined;
}

// Captured before patchConsole can replace it, so the fallback never loops into the logger.
const consoleLog = console.log.bind(console);

function defaultWrite(line: string): void {
  if (typeof process !== "undefined" && typeof process.stdout?.write === "function") {
    process.stdout.write(`${line}\n`);
  } else {
    consoleLog(line);
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = parseLevel(options.level ?? env("LOG_LEVEL"));
  const format = options.format ?? (env("LOG_FORMAT") === "pretty" ? "pretty" : "json");
  const write = options.write ?? defaultWrite;
  const norm: NormalizeOptions = {
    snakeCase: options.snakeCase ?? true,
    redactKeys: [...DEFAULT_REDACT_KEYS, ...(options.redactKeys ?? []).map(toSnakeCase)],
  };

  const make = (bound: Fields): Logger => {
    const emit = (lvl: Level, message: string, fields?: Fields) => {
      if (LEVEL_RANK[lvl] < LEVEL_RANK[level]) return;
      let line: string;
      try {
        const record = buildRecord(lvl, message, [options.base, getContext(), bound, fields], norm);
        line = format === "pretty" ? formatPretty(record) : serializeRecord(record);
      } catch (e) {
        line = JSON.stringify({
          level: "error",
          message: "log serialize failed",
          event: "log.serialize_failed",
          err_message: String((e as Error)?.message ?? e).slice(0, 1000),
          original_message: String(message).slice(0, 500),
        });
      }
      try {
        write(line);
      } catch {
        // Logging must never break the app.
      }
    };
    return {
      level,
      trace: (m, f) => emit("trace", m, f),
      debug: (m, f) => emit("debug", m, f),
      info: (m, f) => emit("info", m, f),
      warn: (m, f) => emit("warn", m, f),
      error: (m, f) => emit("error", m, f),
      fatal: (m, f) => emit("fatal", m, f),
      child: (fields) => make({ ...bound, ...fields }),
      isLevelEnabled: (l) => LEVEL_RANK[l] >= LEVEL_RANK[level],
    };
  };
  return make({});
}
