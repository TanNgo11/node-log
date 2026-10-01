import { propagationHeaders } from "./http";
import type { Logger } from "./logger";

export interface FetchLogOptions {
  peer_service: string;
  /** Forward x-request-id / traceparent. Only for services we own. */
  internal?: boolean;
  slowMs?: number;
  fetch?: typeof fetch;
}

function describeRequest(input: RequestInfo | URL, init?: RequestInit): { method: string; url: string } {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return { method, url };
}

export function createFetch(log: Logger, opts: FetchLogOptions): typeof fetch {
  const slowMs = opts.slowMs ?? 1000;
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const base = opts.fetch ?? globalThis.fetch;
    const { method, url } = describeRequest(input, init);
    let requestInit = init;
    if (opts.internal) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      for (const [k, v] of Object.entries(propagationHeaders())) if (!headers.has(k)) headers.set(k, v);
      requestInit = { ...init, headers };
    }
    const fields = { event: "http.outbound", peer_service: opts.peer_service, http_method: method, http_url: url };
    const start = performance.now();
    try {
      const res = await base(input, requestInit);
      const duration_ms = Math.round(performance.now() - start);
      if (res.status >= 500) {
        log.warn("outbound request failed", { ...fields, http_status: res.status, duration_ms });
      } else if (duration_ms >= slowMs) {
        log.warn("outbound request slow", { ...fields, http_status: res.status, duration_ms });
      }
      return res;
    } catch (err) {
      log.warn("outbound request failed", { ...fields, duration_ms: Math.round(performance.now() - start), err });
      throw err;
    }
  };
  return wrapped as typeof fetch;
}
