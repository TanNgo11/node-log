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
 * Node keeps 10 frames by default; ORM/framework frames (knex, Strapi, Prisma) often use all of
 * them, hiding the app code that triggered a warning or error. Only ever raises the limit.
 */
export function raiseStackTraceLimit(limit: number): void {
  if (Error.stackTraceLimit < limit) Error.stackTraceLimit = limit;
}

export interface ProcessWarningOptions {
  stackTraceLimit?: number;
  /**
   * Remove Node's own stderr printer, so a warning is one JSON line instead of that line plus
   * "(node:1) Warning: ..." and "(Use `node --trace-deprecation ...`...)". Default true.
   */
  replaceDefault?: boolean;
  /**
   * A repeated warning is written at most once per window (default 1 hour). The next line carries
   * `suppressed_count`, the repeats dropped since the previous line, so the frequency stays visible.
   */
  repeatWindowMs?: number;
  now?: () => number;
}

// Distinct warnings tracked; past this a new kind is logged every time instead of throttled.
const MAX_TRACKED_WARNINGS = 200;

/**
 * Logs Node process warnings (deprecations, MaxListeners...) as `process.warning` lines whose
 * err_stack points at the code that triggered them. Repeats are throttled (see repeatWindowMs).
 * Also raises Error.stackTraceLimit (default 30) so the stack reaches past framework frames.
 */
export function logProcessWarnings(log: Logger, opts: ProcessWarningOptions = {}): void {
  if (warningState.installed || typeof process === "undefined" || typeof process.on !== "function") return;
  warningState.installed = true;
  raiseStackTraceLimit(opts.stackTraceLimit ?? 30);
  if (opts.replaceDefault ?? true) {
    for (const l of process.listeners("warning")) if (l.name === "onWarning") process.off("warning", l);
  }
  const windowMs = opts.repeatWindowMs ?? 60 * 60 * 1000;
  const now = opts.now ?? Date.now;
  const tracked = new Map<string, { loggedAt: number; suppressed: number }>();
  process.on("warning", (warning: Error) => {
    const key = `${warning?.name}:${(warning as { code?: unknown })?.code ?? ""}:${warning?.message}`;
    const t = now();
    const entry = tracked.get(key);
    if (entry && t - entry.loggedAt < windowMs) {
      entry.suppressed += 1;
      return;
    }
    if (entry) tracked.set(key, { loggedAt: t, suppressed: 0 });
    else if (tracked.size < MAX_TRACKED_WARNINGS) tracked.set(key, { loggedAt: t, suppressed: 0 });
    log.warn("process warning", {
      event: "process.warning",
      suppressed_count: entry ? entry.suppressed : undefined,
      err: warning,
    });
  });
}
