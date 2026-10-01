// No imports: this module is shared with the edge entry (next-edge).
export const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}

function first(header?: string | string[] | null): string | undefined {
  return Array.isArray(header) ? header[0] : (header ?? undefined);
}

export function resolveRequestId(header?: string | string[] | null): string {
  const value = first(header);
  return value && REQUEST_ID_RE.test(value) ? value : newRequestId();
}

export function parseTraceparent(header?: string | string[] | null): { trace_id: string; span_id: string } | undefined {
  const value = first(header)?.trim().toLowerCase();
  const m = value ? TRACEPARENT_RE.exec(value) : null;
  if (!m) return undefined;
  const [, version, traceId, spanId] = m as unknown as [string, string, string, string];
  if (version === "ff" || /^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;
  return { trace_id: traceId, span_id: spanId };
}
