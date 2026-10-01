import { describe, expect, it } from "vitest";
import { loggedProcessor } from "../src/bullmq";
import { runJob } from "../src/job";
import { capture } from "./helpers";

describe("runJob", () => {
  it("logs job.completed with context fields on every line", async () => {
    const { log, lines } = capture();
    const result = await runJob(log, { job_name: "sync_stock", job_id: 42, request_id: "r1" }, async () => {
      log.info("syncing", { event: "stock.sync_started" });
      return "ok";
    });
    expect(result).toBe("ok");
    const [inner, done] = lines();
    expect(inner).toMatchObject({ job_name: "sync_stock", job_id: "42", request_id: "r1" });
    expect(done).toMatchObject({ level: "info", event: "job.completed", message: "job completed", job_name: "sync_stock" });
    expect(typeof done!.duration_ms).toBe("number");
  });
  it("logs job.failed as warn when retries remain, error on the final attempt", async () => {
    const { log, lines } = capture();
    const fail = async () => {
      throw new Error("smtp timeout");
    };
    await expect(runJob(log, { job_name: "mail", job_attempt: 1, final_attempt: false }, fail)).rejects.toThrow();
    await expect(runJob(log, { job_name: "mail", job_attempt: 3, final_attempt: true }, fail)).rejects.toThrow();
    await expect(runJob(log, { job_name: "mail" }, fail)).rejects.toThrow();
    expect(lines().map((l) => l.level)).toEqual(["warn", "error", "error"]);
    expect(lines()[0]).toMatchObject({ event: "job.failed", job_attempt: 1, err_message: "smtp timeout" });
  });
});

describe("loggedProcessor", () => {
  it("maps BullMQ job fields", async () => {
    const { log, lines } = capture();
    const processor = loggedProcessor(
      log,
      "send_invoice_email",
      async (job: { id: string; attemptsMade: number; opts: { attempts: number }; data: { request_id: string } }) => job.id,
    );
    await processor({ id: "7", attemptsMade: 2, opts: { attempts: 3 }, data: { request_id: "r9" } });
    expect(lines()[0]).toMatchObject({ job_name: "send_invoice_email", job_id: "7", job_attempt: 3, request_id: "r9" });
    const failing = loggedProcessor(log, "x", async () => {
      throw new Error("no");
    });
    await expect(failing({ id: "8", attemptsMade: 0, opts: { attempts: 3 } })).rejects.toThrow();
    expect(lines()[1]).toMatchObject({ level: "warn", job_attempt: 1 });
  });
});
