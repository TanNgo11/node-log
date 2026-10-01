import { runJob } from "./job";
import type { Logger } from "./logger";

/** Minimal shape of a BullMQ Job; avoids depending on bullmq. */
export interface BullJobLike {
  id?: string;
  attemptsMade: number;
  opts?: { attempts?: number };
  data?: unknown;
}

export function loggedProcessor<J extends BullJobLike, R>(
  log: Logger,
  name: string,
  processor: (job: J, token?: string) => Promise<R>,
): (job: J, token?: string) => Promise<R> {
  return (job, token) => {
    const attempt = job.attemptsMade + 1;
    const requestId = (job.data as { request_id?: unknown } | undefined)?.request_id;
    return runJob(
      log,
      {
        job_name: name,
        job_id: job.id,
        job_attempt: attempt,
        final_attempt: attempt >= (job.opts?.attempts ?? 1),
        request_id: typeof requestId === "string" ? requestId : undefined,
      },
      () => processor(job, token),
    );
  };
}
