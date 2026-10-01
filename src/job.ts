import { withContext } from "./context";
import { markLogged } from "./error";
import type { Logger } from "./logger";
import type { Fields } from "./normalize";

export interface JobInfo {
  job_name: string;
  job_id?: string | number;
  job_attempt?: number;
  /** No retries left after this attempt. Defaults to true when unknown. */
  final_attempt?: boolean;
  request_id?: string;
  fields?: Fields;
}

export async function runJob<T>(log: Logger, info: JobInfo, fn: () => T | Promise<T>): Promise<T> {
  const ctx: Fields = { ...info.fields, job_name: info.job_name };
  if (info.job_id !== undefined) ctx.job_id = String(info.job_id);
  if (info.job_attempt !== undefined) ctx.job_attempt = info.job_attempt;
  if (info.request_id !== undefined) ctx.request_id = info.request_id;

  return withContext(ctx, async () => {
    const start = performance.now();
    try {
      const result = await fn();
      log.info("job completed", { event: "job.completed", duration_ms: Math.round(performance.now() - start) });
      return result;
    } catch (err) {
      const final = info.final_attempt ?? true;
      log[final ? "error" : "warn"]("job failed", {
        event: "job.failed",
        duration_ms: Math.round(performance.now() - start),
        err,
      });
      markLogged(err);
      throw err;
    }
  });
}
