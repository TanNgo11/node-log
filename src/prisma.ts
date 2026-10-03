import type { Logger } from "./logger";

export interface PrismaLogOptions {
  /** Log db.slow_query at or above this duration. Default 500 ms. */
  slowMs?: number;
  /**
   * Also log db.error for failed queries. Off by default: the error already reaches the request's
   * http.request line (with err_code such as P2002), and the contract logs each error once.
   */
  logErrors?: boolean;
  /** Value for db_system, e.g. "postgres". */
  db_system?: string;
}

interface OperationParams {
  model?: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
}

function rowsOf(result: unknown): number | undefined {
  if (Array.isArray(result)) return result.length;
  const count = (result as { count?: unknown } | null)?.count;
  return typeof count === "number" ? count : undefined;
}

/**
 * Prisma Client extension (Prisma 5 and 6): `new PrismaClient().$extends(prismaLogging(log))`.
 * Logs model, operation, duration and row count. Never logs SQL text or query arguments.
 */
export function prismaLogging(log: Logger, opts: PrismaLogOptions = {}) {
  const slowMs = opts.slowMs ?? 500;
  return {
    name: "@tanngo11/log",
    query: {
      async $allOperations({ model, operation, args, query }: OperationParams): Promise<unknown> {
        const start = performance.now();
        const fields = () => ({
          db_system: opts.db_system,
          db_operation: operation,
          db_table: model,
          duration_ms: Math.round(performance.now() - start),
        });
        try {
          const result = await query(args);
          const base = fields();
          if (base.duration_ms >= slowMs) {
            log.warn("slow query", { ...base, event: "db.slow_query", db_rows: rowsOf(result) });
          }
          return result;
        } catch (err) {
          if (opts.logErrors) log.error("database error", { ...fields(), event: "db.error", err });
          throw err;
        }
      },
    },
  };
}
