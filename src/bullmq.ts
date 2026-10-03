import { runJob } from "./job";
import type { Logger } from "./logger";

/** Minimal shape of a BullMQ Job; avoids depending on bullmq. */
export interface BullJobLike {
  id?: string;
  attemptsMade: number;
  opts?: { attempts?: number };
  data?: unknown;
}

export function loggedProcessor<J extends BullJobLike, R, A extends unknown[] = [token?: string, signal?: AbortSignal]>(
  log: Logger,
  name: string,
  processor: (job: J, ...rest: A) => Promise<R>,
): (job: J, ...rest: A) => Promise<R> {
  return (job, ...rest) => {
    const attempts = job.opts?.attempts ?? 1;
    const attempt = job.attemptsMade + 1;
    const requestId = (job.data as { request_id?: unknown } | undefined)?.request_id;
    return runJob(
      log,
      {
        job_name: name,
        job_id: job.id,
        job_attempt: attempt,
        // UnrecoverableError skips the remaining retries.
        final_attempt: (err) => attempt >= attempts || (err as { name?: unknown } | null)?.name === "UnrecoverableError",
        request_id: typeof requestId === "string" ? requestId : undefined,
      },
      () => processor(job, ...rest),
    );
  };
}
