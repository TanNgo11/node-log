# @tanngo11/log

Structured JSON logging for Node services. It writes one JSON line per log to stdout, following
[log contract v1](CONTRACT.md),
so every service is searchable the same way in OpenObserve and readable by AI agents through MCP.

- Zero runtime dependencies, Node ≥ 20, ESM and CommonJS.
- Request context (`request_id`, `trace_id`, `user_id`...) on every line via `AsyncLocalStorage`.
- One `http.request` summary line per request, carrying the error when the request fails.
- Adapters for Express, Fastify, NestJS, Next.js (App Router) and BullMQ.

## Install

```bash
npm i @tanngo11/log
# before the npm package is published:
npm i github:TanNgo11/node-log#v0.1.0
```

## Core

```ts
// src/lib/log.ts
import { createLogger } from "@tanngo11/log";

export const log = createLogger();
```

```ts
log.info("order created", { event: "order.created", order_id: order.id, items_count: 3 });
log.warn("shipping quote failed, using flat rate", { event: "shipping_quote.fallback_used", err });
log.error("create order failed", { event: "order.create_failed", err });
```

Every level (`trace`, `debug`, `info`, `warn`, `error`, `fatal`) takes `(message, fields?)`.

- Keep `message` constant. Put variable values in fields.
- `event` is required for `warn`, `error` and `fatal`.
- Pass errors as `err`. They become `err_type`, `err_message`, `err_code`, `err_stack` and
  `err_cause`.

| Env | Default | Meaning |
|---|---|---|
| `LOG_LEVEL` | `info` | minimum level written |
| `LOG_FORMAT` | `json` | `pretty` prints readable lines for local development only |

`createLogger(options)` accepts:
- `level`, `format`;
- `base`: fields added to every line;
- `redactKeys`: extra sensitive keys;
- `snakeCase`: default `true`;
- `write`: replaces stdout, for tests.

### Context

```ts
import { addContext, recordError, withContext } from "@tanngo11/log";

await withContext({ tenant_id }, () => handle());  // every log inside carries tenant_id
addContext({ user_id: user.id });                   // after authentication, inside a request
recordError(err);                                    // attach err to the request's http.request line
```

`log.child({ job_name: "sync_stock" })` returns a logger that always adds those fields.

### What the logger normalizes

Applied in this order:
1. Merges fields: `base`, then context, then `child`, then the call. Later sources win.
2. Flattens nested objects with `_`, up to three key segments (`order.customer.id` becomes
   `order_customer_id`). Arrays and deeper objects become JSON strings.
3. Converts camelCase keys to snake_case (`orderId` becomes `order_id`). Pass `snakeCase: false`
   to turn this off.
4. Prefixes keys that Vector overwrites with `app_`: `project`, `service`, `version`, `host`,
   `msg`, `level`, `message`...
5. Replaces the values of sensitive keys with `[REDACTED]`: `password`, `token`, `authorization`,
   `cookie`, `api_key`..., and any key ending in `_<sensitive key>`.
6. Strips the query string, hash and credentials from `http_path`, `http_url` and every
   `*_url` field.
7. Truncates `message` to 500 chars, `err_stack` to 4000 and other strings to 1000. Lines over
   16000 bytes keep only core fields and get `log_truncated: true`.

The logger never throws into your code.

### Outbound calls, jobs, lifecycle

```ts
import { createFetch, installProcessHandlers, logStartup, runJob } from "@tanngo11/log";

const ghn = createFetch(log, { peer_service: "ghn" });                 // logs http.outbound on 5xx, network error, or > 1s
const api = createFetch(log, { peer_service: "backend-api", internal: true }); // also forwards x-request-id / traceparent

await runJob(log, { job_name: "sync_stock", job_id: id }, () => syncStock()); // job.completed / job.failed

installProcessHandlers(log); // app.crashed (fatal, exit 1) on uncaught errors; app.stopping on SIGTERM/SIGINT
logStartup(log, { port: 3000 }); // app.started
```

## Express

```ts
import { errorRecorder, requestLogger } from "@tanngo11/log/express";

app.use(requestLogger(log));   // before routes
// ... routes ...
app.use(errorRecorder());      // after routes, before your error handler
app.use(yourErrorHandler);
```

## Fastify

```ts
import { fastifyLogger } from "@tanngo11/log/fastify";

const app = Fastify({ logger: false });
await app.register(fastifyLogger, { log });
```

## NestJS (Express adapter)

```ts
import { ErrorRecorderInterceptor, NestLogger, requestLogger } from "@tanngo11/log/nest";

const app = await NestFactory.create(AppModule, { logger: new NestLogger(log) });
app.use(requestLogger(log));
app.useGlobalInterceptors(new ErrorRecorderInterceptor());
```

Nest's own logs become JSON with `nest_context`. Unhandled exceptions are written once, on the
`http.request` line, not again by Nest's `ExceptionsHandler`. Requires `rxjs` (already a Nest
dependency).

## Next.js (App Router)

Route handlers:

```ts
// app/api/orders/[id]/route.ts
import { withLogging } from "@tanngo11/log/next";
import { log } from "@/lib/log";

export const GET = withLogging(log, async (request, { params }) => { /* ... */ }, { route: "/api/orders/[id]" });
```

Server components, server actions and anything not wrapped:

```ts
// instrumentation.ts
import { nextOnRequestError, registerNext } from "@tanngo11/log/next";
import { log } from "@/lib/log";

export function register() {
  registerNext(log); // app.started + crash logging (Next keeps serving, so no exit)
}
export const onRequestError = nextOnRequestError(log);
```

Optional: give every request an `x-request-id` in `middleware.ts` (edge runtime):

```ts
import { withRequestId } from "@tanngo11/log/next/edge";

export function middleware(request: NextRequest) {
  return NextResponse.next({ request: { headers: withRequestId(request) } });
}
```

Notes:
- `redirect()` and `notFound()` are logged with their real status (307, 404), not as errors.
- Errors already logged by `withLogging` are not logged again by `onRequestError`.
- If the edge build complains about the import in `instrumentation.ts`, import inside
  `register()`: `if (process.env.NEXT_RUNTIME === "nodejs") { const { registerNext } = await import("@tanngo11/log/next"); ... }`.

## BullMQ

```ts
import { loggedProcessor } from "@tanngo11/log/bullmq";

new Worker("invoices", loggedProcessor(log, "send_invoice_email", async (job) => { /* ... */ }));
```

- The final attempt fails at `error` level, earlier attempts at `warn`.
- Put `request_id` in `job.data` when enqueueing from a request, so the job's logs link back to
  that request.

## Migrating from the shared winston logger

For repos using the old shared winston logger (S3 transport, nested metadata):

1. Replace `src/lib/logger/index.ts` with `export const log = createLogger(); export const logger = log;`.
2. Rewrite each `log.error(msg, err, meta)` call as `log.error(msg, { ...meta, err })`.
3. In `withErrorHandler`, replace the `logger.error("API Error", ...)` call with
   `recordError(error)`. Then wrap routes with `withLogging`.
4. Remove the S3 transport. OpenObserve already stores the logs.

## Rules the library cannot enforce

- Use a constant `message` and stable `event` names.
- Never log request or response bodies, query strings, email addresses, phone numbers, tokens or
  card data.

See sections 4 and 5 of the contract.
