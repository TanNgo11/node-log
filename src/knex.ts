import type { Logger } from "./logger";

export interface KnexLogOptions {
  /** Log db.slow_query at or above this duration. Default 500 ms. */
  slowMs?: number;
  /**
   * Also log db.error for failed queries. Off by default: an error that fails the request already
   * reaches its http.request line. Turn it on when the app swallows errors inside transactions:
   * Postgres then answers every later query with 25P02 ("current transaction is aborted"), and
   * only this line shows the query that failed first. 25P02 itself is never logged here.
   */
  logErrors?: boolean;
  /** Value for db_system, e.g. "postgres". */
  db_system?: string;
  now?: () => number;
}

/** The part of a knex instance (strapi.db.connection) knexLogging uses. */
export interface KnexLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
}

interface QueryData {
  __knexQueryUid?: string;
  method?: string;
  sql?: string;
}

// Max queries in flight we track; a query that never answers must not grow the map forever.
const MAX_PENDING = 10_000;

const TABLE_RE = /\b(?:from|into|update|join)\s+((?:"[^"]+"|`[^`]+`|[\w$]+)(?:\.(?:"[^"]+"|`[^`]+`|[\w$]+))?)/i;

/** The first table a statement names, without schema or quotes. The SQL itself is never logged. */
export function tableOf(sql: string | undefined): string | undefined {
  const match = sql ? TABLE_RE.exec(sql) : null;
  if (!match?.[1]) return undefined;
  const last = match[1].split(".").pop() ?? "";
  return last.replace(/^["`]|["`]$/g, "") || undefined;
}

function operationOf(data: QueryData): string | undefined {
  if (data.method && data.method !== "raw") return data.method;
  return /^\s*(\w+)/.exec(data.sql ?? "")?.[1]?.toLowerCase();
}

/**
 * Query logging for knex (Strapi: `knexLogging(strapi.db.connection, log)` in bootstrap()).
 * Logs db.slow_query (warn) with db_operation, db_table and duration_ms, and optionally db.error.
 * Never logs SQL text or bindings.
 */
export function knexLogging(knex: KnexLike, log: Logger, opts: KnexLogOptions = {}): void {
  const slowMs = opts.slowMs ?? 500;
  const now = opts.now ?? (() => performance.now());
  const started = new Map<string, number>();

  const finish = (data: QueryData | undefined) => {
    const uid = data?.__knexQueryUid;
    if (!uid) return undefined;
    const start = started.get(uid);
    started.delete(uid);
    return start === undefined ? undefined : Math.round(now() - start);
  };
  const base = (data: QueryData, duration: number | undefined) => ({
    db_system: opts.db_system,
    db_operation: operationOf(data),
    db_table: tableOf(data.sql),
    duration_ms: duration,
  });

  knex.on("query", (data: QueryData) => {
    const uid = data?.__knexQueryUid;
    if (!uid) return;
    if (started.size >= MAX_PENDING) started.clear();
    started.set(uid, now());
  });

  knex.on("query-response", (response: unknown, data: QueryData) => {
    const duration = finish(data);
    if (duration === undefined || duration < slowMs) return;
    const rows = Array.isArray(response) ? response.length : undefined;
    log.warn("slow query", { ...base(data, duration), event: "db.slow_query", db_rows: rows });
  });

  knex.on("query-error", (err: unknown, data: QueryData) => {
    const duration = finish(data);
    if (!opts.logErrors) return;
    if ((err as { code?: unknown } | null)?.code === "25P02") return;
    // err_message drops the statement knex prefixed (see stripSql in serializeError).
    log.error("database error", { ...base(data ?? {}, duration), event: "db.error", err });
  });
}
