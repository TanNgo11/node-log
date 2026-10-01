import { describe, expect, it } from "vitest";
import { withContext } from "../src/context";
import { createFetch } from "../src/fetch";
import { capture } from "./helpers";

function fakeFetch(status: number, delayMs = 0, seen: Request[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(input, init));
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return new Response("x", { status });
  }) as typeof fetch;
}

describe("createFetch", () => {
  it("does not log fast successful calls", async () => {
    const { log, lines } = capture();
    const f = createFetch(log, { peer_service: "ghn", fetch: fakeFetch(200) });
    await f("https://api.ghn.vn/fee?token=1");
    expect(lines()).toHaveLength(0);
  });
  it("logs 5xx and slow calls as warn without query strings", async () => {
    const { log, lines } = capture();
    await createFetch(log, { peer_service: "ghn", fetch: fakeFetch(503) })("https://api.ghn.vn/fee?token=1", { method: "post" });
    await createFetch(log, { peer_service: "ghn", slowMs: 5, fetch: fakeFetch(200, 20) })("https://api.ghn.vn/fee");
    const [failed, slow] = lines();
    expect(failed).toMatchObject({
      level: "warn",
      event: "http.outbound",
      message: "outbound request failed",
      peer_service: "ghn",
      http_method: "POST",
      http_url: "https://api.ghn.vn/fee",
      http_status: 503,
    });
    expect(slow).toMatchObject({ level: "warn", event: "http.outbound", message: "outbound request slow", http_status: 200 });
  });
  it("logs network errors and rethrows", async () => {
    const { log, lines } = capture();
    const boom = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(createFetch(log, { peer_service: "s3", fetch: boom })("https://s3/x")).rejects.toThrow("fetch failed");
    expect(lines()[0]).toMatchObject({ level: "warn", event: "http.outbound", err_type: "TypeError" });
    expect(lines()[0]!.http_status).toBeUndefined();
  });
  it("forwards x-request-id only for internal services", async () => {
    const { log } = capture();
    const seen: Request[] = [];
    await withContext({ request_id: "r1" }, async () => {
      await createFetch(log, { peer_service: "api", internal: true, fetch: fakeFetch(200, 0, seen) })("https://api/x");
      await createFetch(log, { peer_service: "stripe", fetch: fakeFetch(200, 0, seen) })("https://stripe/x");
    });
    expect(seen[0]!.headers.get("x-request-id")).toBe("r1");
    expect(seen[1]!.headers.get("x-request-id")).toBeNull();
  });
});
