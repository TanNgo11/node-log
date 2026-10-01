import { globalSingleton } from "./global";
import type { Logger } from "./logger";
import type { Fields } from "./normalize";

export function logStartup(log: Logger, fields: Fields = {}): void {
  log.info("app started", {
    event: "app.started",
    runtime_version: `node ${process.versions.node}`,
    log_level: log.level,
    ...fields,
  });
}

export interface ProcessHandlerOptions {
  /** Exit with code 1 after an uncaught error. Next.js keeps serving, so its adapter passes false. */
  exitOnCrash?: boolean;
  exit?: (code: number) => void;
}

export function crashHandlers(log: Logger, opts: ProcessHandlerOptions = {}) {
  const exitOnCrash = opts.exitOnCrash ?? true;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const crash = (source: string, err: unknown) => {
    if (exitOnCrash) {
      log.fatal("app crashed", { event: "app.crashed", crash_source: source, err });
      exit(1);
    } else {
      log.error("unhandled error", { event: "app.unhandled_error", crash_source: source, err });
    }
  };
  return {
    onUncaught: (err: unknown) => crash("uncaughtException", err),
    onRejection: (reason: unknown) => crash("unhandledRejection", reason),
    onSignal: (signal: NodeJS.Signals) => log.info("app stopping", { event: "app.stopping", signal }),
  };
}

const state = globalSingleton("process", () => ({ installed: false }));

export function installProcessHandlers(log: Logger, opts: ProcessHandlerOptions = {}): void {
  if (state.installed || typeof process === "undefined" || typeof process.on !== "function") return;
  state.installed = true;
  const h = crashHandlers(log, opts);
  process.on("uncaughtException", h.onUncaught);
  process.on("unhandledRejection", h.onRejection);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      h.onSignal(signal);
      // A listener disables Node's default "terminate on signal". If nobody else handles
      // the signal, re-raise it now that ours is removed so the process still stops.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    });
  }
}
