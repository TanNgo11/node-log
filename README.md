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
- `redactKeys`, `redactValues`, `redact`: custom redaction (see below);
- `snakeCase`: default `true`;
- `write`: replaces stdout, for tests.

### Custom redaction

```ts
import { createLogger, REDACT_PATTERNS } from "@tanngo11/log";

export const log = createLogger({
  // extra key names, or RegExp tested on the snake_case key
  redactKeys: ["tax_code", /^national_id/],
  // value patterns masked in every string, including messages
  redactValues: [REDACT_PATTERNS.phoneVN, REDACT_PATTERNS.paymentCard],
  // last step for each field; return undefined to drop the field
  redact: (key, value) => (key === "customer_name" && typeof value === "string" ? `${value[0]}***` : value),
});
```

- `REDACT_PATTERNS` currently contains `phoneVN`, `paymentCard` and `ipv4`.
- These patterns are opt-in because they can match ordinary numbers. `paymentCard` does not
  match 13-digit millisecond timestamps.
- The `redact` hook never receives `level`, `message` or `event`.
- If the hook throws, that line becomes a `log.serialize_failed` line instead.

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
5. Replaces the values of sensitive keys with `[REDACTED]`, at any depth, including inside
   arrays.
   - A key counts as sensitive when any snake_case part of it names a secret: `password`,
     `secret`, `token`, `api_key`, `authorization`, `cookie`, `session_id`, `credentials`, `dsn`,
     `connection_string`, `jwt`...
   - So `stripeSecretKey` and `x-api-key` are redacted.
   - Keys that only describe a secret stay readable: `token_count`, `token_type`,
     `password_reset_at`.
   - `redactKeys` adds more key names.
6. Masks secrets inside any string value or message:
   - credentials in URLs (`postgres://[REDACTED]@db`);
   - `Bearer` tokens;
   - JWTs;
   - email addresses (`***@example.com`).
7. Strips the query string, hash and credentials from `http_path`, `http_url` and every
   `*_url` field.
8. Truncates `message` to 500 chars, `err_stack` to 4000 and other strings to 1000. Lines over
   16000 bytes keep only core fields and get `log_truncated: true`.

The logger never throws into your code.

### Outbound calls, jobs, lifecycle

```ts
import { createFetch, installProcessHandlers, jobData, logShutdown, logStartup, runJob } from "@tanngo11/log";

const ghn = createFetch(log, { peer_service: "ghn" });                 // logs http.outbound on 5xx, network error, or > 1s
const api = createFetch(log, { peer_service: "backend-api", internal: true }); // also forwards x-request-id / traceparent

await runJob(log, { job_name: "sync_stock", job_id: id }, () => syncStock()); // job.completed / job.failed
await queue.add("send_invoice", jobData({ invoice_id }));             // carries the current request_id into the job

installProcessHandlers(log); // app.crashed on uncaught errors, then exit(1) after 1s so Sentry & co. can flush
logProcessWarnings(log);     // Node warnings (deprecations...) as process.warning with the call-site stack
logStartup(log, { port: 3000 }); // app.started

process.once("SIGTERM", async () => {
  logShutdown(log, { signal: "SIGTERM" }); // app.stopping; the library never handles signals itself
  await server.close();
  process.exit(0);
});
```

### Legacy `console.*` calls

```ts
import { patchConsole } from "@tanngo11/log";

patchConsole(log); // console.log/info → info, warn → warn, error → error, debug/trace → debug
```

Every `console.*` call becomes a JSON line with `event: "console"` and the request context. This
gets an old codebase to contract level L1 in one line. Framework output that goes through
`console`, such as Next.js error printing, is covered too. The function returns `restore()`.

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

## NestJS (Express or Fastify adapter)

```ts
import { NestLogger, setupNestLogging } from "@tanngo11/log/nest";

const app = await NestFactory.create(AppModule, { logger: new NestLogger(log) });
// or: NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: new NestLogger(log) })
await setupNestLogging(app, log); // before app.listen()
```

`setupNestLogging` detects the adapter:
- Express gets the `requestLogger` middleware.
- Fastify gets the `fastifyLogger` plugin.

Both get `ErrorRecorderInterceptor`. For manual setup, `requestLogger`, `fastifyLogger` and
`ErrorRecorderInterceptor` are exported too.

Nest's own logs become JSON with `nest_context`. Extra arguments are kept: objects become fields,
other values go to `nest_args`. Unhandled exceptions are written once, on the
`http.request` line, not again by Nest's `ExceptionsHandler`. Requires `rxjs` (already a Nest
dependency).

## Next.js (App Router)

Route handlers:

```ts
// app/api/orders/[id]/route.ts
import { withLogging } from "@tanngo11/log/next";
import { log } from "@/lib/log";

export const GET = withLogging(log, async (request: NextRequest, { params }) => { /* ... */ }, { route: "/api/orders/[id]" });
```

Server actions:

```ts
"use server";
import { withAction } from "@tanngo11/log/next";

export const saveOrder = withAction(log, "save_order", async (input: OrderInput) => { /* ... */ });
// action.completed (info) or action.failed (error, once); redirect()/notFound() count as completed
```

Server components and anything not wrapped:

```ts
// instrumentation.ts
import { patchConsole } from "@tanngo11/log";
import { nextConsoleSkip, nextOnRequestError, registerNext } from "@tanngo11/log/next";
import { log } from "@/lib/log";

export function register() {
  registerNext(log); // app.started, crash and process-warning logging (Next keeps serving, so no exit)
  // Next prints render errors with console.error before onRequestError logs them:
  // nextConsoleSkip drops that copy so each error is one line.
  patchConsole(log, { skip: nextConsoleSkip });
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

- A failure on the final attempt, or an `UnrecoverableError`, is logged at `error`. Earlier
  attempts fail at `warn`.
- When enqueueing from a request, use `queue.add(name, jobData(data))`. The job's logs then carry
  that request's `request_id`.

## Strapi 5

`config/logger.ts` routes every `strapi.log.*` call (app code and framework) through the logger:

```ts
import { strapiLoggerConfig } from "@tanngo11/log/strapi";
import { log } from "../src/shared/log";

export default strapiLoggerConfig(log);
```

`config/middlewares.ts` replaces `'strapi::logger'` and adds the error capture right after
`'strapi::errors'`:

```ts
// src/middlewares/http-log/index.ts
import { strapiRequestLogger } from "@tanngo11/log/strapi";
import { log } from "../../shared/log";
export default () => strapiRequestLogger({ log });

// src/middlewares/error-capture/index.ts
import { strapiErrorCapture } from "@tanngo11/log/strapi";
export default () => strapiErrorCapture();

// config/middlewares.ts
return [
  { resolve: "./src/middlewares/http-log" },      // instead of 'strapi::logger', first in the list
  "strapi::errors",
  { resolve: "./src/middlewares/error-capture" }, // right after strapi::errors
  // ...
];
```

- Each request gets one `http.request` line with the full route template (`/api/articles/:id`,
  read from `@koa/router`), its status and duration.
- An unhandled error is written once, on that line. The copy that `strapi::errors` logs through
  `strapi.log.error` is not written again.
- Errors the app logs itself through `strapi.log.error(err)` stay as their own lines, with
  `event: "strapi.log"`.
- `request_id` reuses `ctx.state.requestId` when the app sets one (configurable with `stateKey`).
  Otherwise a UUID is put there, so the app's own correlation middleware keeps the same id.
- The caller's `x-request-id` (for example from a Next.js BFF) is not trusted as the request id.
  It is recorded as `upstream_request_id`, which links both services' logs. Set
  `trustIncomingRequestId: true` to adopt it instead.
- Winston levels are mapped: `http` and `verbose` become `debug`, `silly` becomes `trace`.
  `LOG_LEVEL` filters. A level set on the winston logger at runtime is honoured too: Strapi's
  data export/import commands set it to `error`.

Tested against the versions Strapi 5.51 uses: Koa 2, `@koa/router` 12 and winston 3.10.

In `register()` of `src/index.ts`:

```ts
import { logProcessWarnings } from "@tanngo11/log";
import { strapiServerErrors } from "@tanngo11/log/strapi";

register({ strapi }) {
  logProcessWarnings(log);
  strapiServerErrors(strapi.server.app, log);
}
```

- `logProcessWarnings` removes Node's own stderr copy of each warning and logs each distinct
  warning once per process (pg repeats its deprecation on every query). Pass
  `{ replaceDefault: false }` to keep Node's printer.
- `strapiServerErrors` replaces Koa's default error printer. Koa prints errors that never reach a
  middleware (a client that hung up mid-upload, an HTTP parse error) with `console.error`, which
  becomes one plain stderr line per stack frame. They become one `http.server_error` line with
  `err_stack`, `http_method`, `http_path` and `request_id`. Client disconnects (`aborted`,
  `ECONNRESET`, `HPE_*`...) are `warn` with `client_disconnect: true`; anything else is `error`.

## Prisma (5 and 6)

```ts
import { prismaLogging } from "@tanngo11/log/prisma";

export const prisma = new PrismaClient().$extends(prismaLogging(log, { db_system: "postgres" }));
```

- Logs `db.slow_query` (`warn`) for queries that take 500 ms or more (`slowMs`). Fields:
  `db_table` (the model), `db_operation` (`findMany`, `$queryRaw`...), `db_rows`, `duration_ms`.
- Never logs SQL text or query arguments.
- Failed queries are not logged by default. The error already reaches the request's
  `http.request` line with `err_code` (`P2002`...), and the contract logs each error once. Pass
  `logErrors: true` to also get a `db.error` line.

## Migrating from the shared winston logger

For repos using the old shared winston logger (S3 transport, nested metadata):

1. Replace `src/lib/logger/index.ts` with `export const log = createLogger(); export const logger = log;`.
2. Rewrite each `log.error(msg, err, meta)` call as `log.error(msg, { ...meta, err })`.
3. In `withErrorHandler`, replace the `logger.error("API Error", ...)` call with
   `recordError(error)`. Then wrap routes with `withLogging`.
4. Remove the S3 transport. OpenObserve already stores the logs.
5. Call `patchConsole(log)` once at startup. Remaining `console.*` calls are then JSON too.

## Rules the library cannot enforce

- Use a constant `message` and stable `event` names.
- Never log request or response bodies, query strings, email addresses, phone numbers, tokens or
  card data.

See sections 4 and 5 of the contract.
