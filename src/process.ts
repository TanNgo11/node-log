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

/** Call at the start of your own shutdown handler (e.g. on SIGTERM). The library never handles signals. */
export function logShutdown(log: Logger, fields: Fields = {}): void {
  log.info("app stopping", { event: "app.stopping", ...fields });
}

export interface ProcessHandlerOptions {
  /** Exit with code 1 after an uncaught error. Next.js keeps serving, so its adapter passes false. */
  exitOnCrash?: boolean;
  /** Time other crash handlers (Sentry, APM) get to flush before exit. Default 1000 ms. */
  exitDelayMs?: number;
  exit?: (code: number) => void;
}

export function crashHandlers(log: Logger, opts: ProcessHandlerOptions = {}) {
  const exitOnCrash = opts.exitOnCrash ?? true;
  const exitDelayMs = opts.exitDelayMs ?? 1000;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let exiting = false;
  const crash = (source: string, err: unknown) => {
    if (!exitOnCrash) {
      log.error("unhandled error", { event: "app.unhandled_error", crash_source: source, err });
      return;
    }
    log.fatal("app crashed", { event: "app.crashed", crash_source: source, err });
    if (exiting) return;
    exiting = true;
    if (typeof process !== "undefined") process.exitCode = 1;
    // Deferred so listeners registered after ours still run; unref so a process with nothing
    // left to do exits on its own (with exitCode 1) without waiting.
    const timer = setTimeout(() => exit(1), exitDelayMs);
    (timer as { unref?: () => void }).unref?.();
  };
  return {
    onUncaught: (err: unknown) => crash("uncaughtException", err),
    onRejection: (reason: unknown) => crash("unhandledRejection", reason),
  };
}

const state = globalSingleton("process", () => ({ installed: false }));

/** Logs uncaught exceptions and unhandled rejections. Does not touch SIGTERM/SIGINT. */
export function installProcessHandlers(log: Logger, opts: ProcessHandlerOptions = {}): void {
  if (state.installed || typeof process === "undefined" || typeof process.on !== "function") return;
  state.installed = true;
  const h = crashHandlers(log, opts);
  process.on("uncaughtException", h.onUncaught);
  process.on("unhandledRejection", h.onRejection);
}

const warningState = globalSingleton("warnings", () => ({ installed: false }));

/**
 * Logs Node process warnings (deprecations, MaxListeners...) as `process.warning` lines whose
 * err_stack points at the code that triggered them. Node still prints its own stderr copy
 * unless the process runs with --no-warnings (NODE_OPTIONS=--no-warnings).
 */
export function logProcessWarnings(log: Logger): void {
  if (warningState.installed || typeof process === "undefined" || typeof process.on !== "function") return;
  warningState.installed = true;
  process.on("warning", (warning: Error) => {
    log.warn("process warning", { event: "process.warning", err: warning });
  });
}
