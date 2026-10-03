import { describe, expect, it } from "vitest";
import { recordError } from "../src/context";
import { withRequestId } from "../src/next-edge";
import { nextControlStatus, nextOnRequestError, withLogging } from "../src/next";
import { capture } from "./helpers";

const req = (url: string, init?: RequestInit) => new Request(`http://localhost${url}`, init);

describe("withLogging", () => {
  it("logs http.request with the given route and shares request_id", async () => {
    const { log, lines } = capture();
    const GET = withLogging(
      log,
      async (_r: Request, _ctx: { params: Promise<{ id: string }> }) => {
        log.info("loading order", { event: "order.loaded" });
        return Response.json({ ok: true });
      },
      { route: "/api/orders/[id]" },
    );
    const res = await GET(req("/api/orders/7?token=x", { headers: { "x-request-id": "r-1" } }), {
      params: Promise.resolve({ id: "7" }),
    });
    expect(res.headers.get("x-request-id")).toBe("r-1");
    const [inner, summary] = lines();
    expect(inner).toMatchObject({ event: "order.loaded", request_id: "r-1" });
    expect(summary).toMatchObject({
      event: "http.request",
      http_method: "GET",
      http_route: "/api/orders/[id]",
      http_path: "/api/orders/7",
      http_status: 200,
      request_id: "r-1",
    });
  });
  it("logs a thrown error once as 500 and rethrows", async () => {
    const { log, lines } = capture();
    const boom = new Error("db down");
    const POST = withLogging(log, async () => {
      throw boom;
    });
    await expect(POST(req("/api/orders", { method: "POST" }), {})).rejects.toBe(boom);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ level: "error", http_status: 500, err_message: "db down" });
    await nextOnRequestError(log)(
      boom,
      { path: "/api/orders", method: "POST", headers: {} },
      { routePath: "/api/orders", routeType: "route" },
    );
    expect(lines()).toHaveLength(1);
  });
  it("treats redirect and notFound control errors as their status, not 500", async () => {
    const { log, lines } = capture();
    const redirectErr = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" });
    const notFoundErr = Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
    for (const e of [redirectErr, notFoundErr]) {
      const handler = withLogging(log, async () => {
        throw e;
      });
      await expect(handler(req("/x"), {})).rejects.toBe(e);
    }
    expect(lines().map((l) => [l.level, l.http_status])).toEqual([
      ["info", 307],
      ["warn", 404],
    ]);
    expect(lines()[0]!.err_type).toBeUndefined();
  });
  it("records errors passed to recordError on the summary line", async () => {
    const { log, lines } = capture();
    const GET = withLogging(log, async () => {
      recordError(new Error("handled"));
      return Response.json({}, { status: 500 });
    });
    await GET(req("/x"), {});
    expect(lines()[0]).toMatchObject({ level: "error", http_status: 500, err_message: "handled" });
  });
});

describe("nextControlStatus", () => {
  it.each([
    [{ digest: "NEXT_REDIRECT;push;/a;308;" }, 308],
    [{ digest: "NEXT_REDIRECT;replace;/a" }, 307],
    [{ digest: "NEXT_NOT_FOUND" }, 404],
    [{ digest: "NEXT_HTTP_ERROR_FALLBACK;401" }, 401],
    [new Error("x"), undefined],
  ])("%o -> %s", (err, status) => expect(nextControlStatus(err)).toBe(status));
});

describe("nextOnRequestError", () => {
  it("logs render errors with routePath, route type and digest", async () => {
    const { log, lines } = capture();
    const err = Object.assign(new Error("render failed"), { digest: "123456" });
    await nextOnRequestError(log)(
      err,
      { path: "/blog/hello?ref=x", method: "GET", headers: { "x-request-id": "r-2" } },
      { routerKind: "App Router", routePath: "/blog/[slug]", routeType: "render" },
    );
    expect(lines()[0]).toMatchObject({
      level: "error",
      event: "http.request",
      http_status: 500,
      http_route: "/blog/[slug]",
      http_path: "/blog/hello",
      request_id: "r-2",
      next_route_type: "render",
      next_digest: "123456",
      err_message: "render failed",
    });
  });
  it("ignores control-flow errors and tolerates missing arguments", async () => {
    const { log, lines } = capture();
    const handler = nextOnRequestError(log);
    await handler({ digest: "NEXT_REDIRECT;replace;/a;307;" }, { path: "/a", method: "GET", headers: {} }, {});
    await handler(new Error("x"), undefined as never, undefined as never);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ http_method: "GET", http_status: 500 });
  });
});

describe("withRequestId (edge)", () => {
  it("keeps a valid id and replaces invalid ones", () => {
    expect(withRequestId(req("/", { headers: { "x-request-id": "r-1" } })).get("x-request-id")).toBe("r-1");
    expect(withRequestId(req("/", { headers: { "x-request-id": "bad id" } })).get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(withRequestId(req("/")).get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

class NextRequestLike extends Request {
  nextUrl = new URL(this.url);
}

describe("withLogging typing and odd throws", () => {
  it("accepts handlers typed with a Request subclass such as NextRequest", async () => {
    const { log, lines } = capture();
    const GET = withLogging(log, async (r: NextRequestLike, ctx: { params: Promise<{ id: string }> }) =>
      Response.json({ path: r.nextUrl.pathname, id: (await ctx.params).id }),
    );
    const res = await GET(new NextRequestLike("http://localhost/a"), { params: Promise.resolve({ id: "1" }) });
    expect(await res.json()).toEqual({ path: "/a", id: "1" });
    expect(lines()[0]).toMatchObject({ http_status: 200 });
  });
  it("logs a thrown non-error once, even when onRequestError sees it later", async () => {
    const { log, lines } = capture();
    const GET = withLogging(log, async () => {
      throw "boom";
    });
    const thrown = await GET(req("/x"), {}).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("boom");
    await nextOnRequestError(log)(thrown, { path: "/x", method: "GET", headers: {} }, {});
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ level: "error", err_message: "boom" });
  });
});
