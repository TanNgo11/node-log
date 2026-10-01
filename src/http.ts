import { getContext } from "./context";
import { markLogged, serializeError } from "./error";
import type { Logger } from "./logger";
import { stripUrl, type Fields } from "./normalize";
import { parseTraceparent, resolveRequestId } from "./request-id";

export { newRequestId, parseTraceparent, REQUEST_ID_RE, resolveRequestId } from "./request-id";

export type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function header(headers: HeaderSource, name: string): string | string[] | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  return (headers as Record<string, string | string[] | undefined>)[name];
}

export function requestContextFields(headers: HeaderSource): { request_id: string; trace_id?: string; span_id?: string } {
  const out: { request_id: string; trace_id?: string; span_id?: string } = {
    request_id: resolveRequestId(header(headers, "x-request-id")),
  };
  const tp = parseTraceparent(header(headers, "traceparent"));
  if (tp) Object.assign(out, tp);
  return out;
}

// Headers to forward to services we own, so their logs share request_id / trace_id.
export function propagationHeaders(): Record<string, string> {
  const ctx = getContext();
  const out: Record<string, string> = {};
  if (typeof ctx.request_id === "string") out["x-request-id"] = ctx.request_id;
  if (typeof ctx.trace_id === "string" && typeof ctx.span_id === "string") {
    out.traceparent = `00-${ctx.trace_id}-${ctx.span_id}-01`;
  }
  return out;
}

export const DEFAULT_SKIP_PATHS: (string | RegExp)[] = [
  /^\/(health|healthz|ready|readyz|livez)\/?$/,
  "/favicon.ico",
  /^\/_next\/static\//,
];

export interface HttpLogOptions {
  skipPaths?: (string | RegExp)[];
}

export interface HttpRequestInfo {
  method: string;
  route?: string;
  path: string;
  status: number;
  duration_ms?: number;
  err?: unknown;
  fields?: Fields;
}

export function shouldSkip(method: string, path: string, skipPaths: (string | RegExp)[] = DEFAULT_SKIP_PATHS): boolean {
  if (method.toUpperCase() === "OPTIONS") return true;
  const p = stripUrl(path);
  return skipPaths.some((s) => (typeof s === "string" ? p === s : s.test(p)));
}

// Writes the one `http.request` summary line for an inbound request.
export function logHttpRequest(log: Logger, info: HttpRequestInfo, opts: HttpLogOptions = {}): void {
  if (shouldSkip(info.method, info.path, opts.skipPaths)) return;
  const level = info.status >= 500 ? "error" : info.status >= 400 ? "warn" : "info";
  const path = stripUrl(info.path);
  const errFields: Fields = {};
  if (info.err !== undefined && info.err !== null) {
    Object.assign(errFields, serializeError(info.err));
    if (info.status < 500) delete errFields.err_stack;
    markLogged(info.err);
  }
  log[level](`${info.method} ${info.route ?? path} ${info.status}`, {
    ...info.fields,
    event: "http.request",
    http_method: info.method,
    http_route: info.route,
    http_path: path,
    http_status: info.status,
    duration_ms: info.duration_ms === undefined ? undefined : Math.round(info.duration_ms),
    ...errFields,
  });
}
