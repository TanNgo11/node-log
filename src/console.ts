import { isErrorLike, isLogged } from "./error";
import type { Level } from "./levels";
import type { Logger } from "./logger";
import { defaultRedactor } from "./redact";

const METHODS = { log: "info", info: "info", warn: "warn", error: "error", debug: "debug", trace: "debug" } as const;
type Method = keyof typeof METHODS;
type ConsoleFn = (...args: unknown[]) => void;

export interface PatchConsoleOptions {
  /** Return true to drop a console call, e.g. errors a framework hook will log anyway. */
  skip?: (args: unknown[]) => boolean;
}

/**
 * Routes console.log/info/warn/error/debug/trace through the logger, so legacy console calls
 * and framework output (e.g. Next.js errors) become JSON lines with request context.
 * Calls carrying an error that is already on a summary line are dropped.
 * Returns a function that restores the previous console methods.
 */
export function patchConsole(log: Logger, opts: PatchConsoleOptions = {}): () => void {
  const target = console as unknown as Record<Method, ConsoleFn>;
  const saved = {} as Record<Method, ConsoleFn>;
  let inside = false;

  for (const method of Object.keys(METHODS) as Method[]) {
    const previous = target[method];
    saved[method] = previous;
    const level: Level = METHODS[method];
    target[method] = (...args: unknown[]) => {
      // A write path that itself uses console must not loop back into the logger.
      if (inside) return previous.apply(console, args);
      inside = true;
      try {
        if (args.some((arg) => isErrorLike(arg) && isLogged(arg)) || opts.skip?.(args)) return;
        let err: unknown;
        const parts: string[] = [];
        for (const arg of args) {
          if (isErrorLike(arg)) {
            err ??= arg;
            parts.push(arg.message);
          } else {
            parts.push(typeof arg === "string" ? arg : defaultRedactor.json(arg));
          }
        }
        log[level](parts.join(" "), { event: "console", console_method: method, err });
      } finally {
        inside = false;
      }
    };
  }

  return () => {
    for (const method of Object.keys(saved) as Method[]) target[method] = saved[method];
  };
}
