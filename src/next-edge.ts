import { newRequestId, REQUEST_ID_RE } from "./request-id";

/**
 * For middleware.ts (edge runtime). Returns request headers that carry a valid x-request-id:
 * `return NextResponse.next({ request: { headers: withRequestId(request) } })`.
 */
export function withRequestId(request: Request): Headers {
  const headers = new Headers(request.headers);
  const current = headers.get("x-request-id");
  if (!current || !REQUEST_ID_RE.test(current)) headers.set("x-request-id", newRequestId());
  return headers;
}
