# Changelog

## 0.5.0

Added:
- `strapiServerErrors(strapi.server.app, log)` (`/strapi`): replaces Koa's default error printer.
  In production, "aborted" and "Parse Error" stacks reached the logs as one plain stderr line per
  frame, with the frames at `info`. They are now one `http.server_error` line. Client
  disconnects are `warn` with `client_disconnect: true`.

Changed:
- `logProcessWarnings` removes Node's own stderr printer (option `replaceDefault`, default true),
  so a warning is one JSON line instead of three. The "(Use `node --trace-deprecation ...`)"
  line was ingested at level `trace`.
- `logProcessWarnings` logs each distinct warning once per process. pg repeated the same
  deprecation many times a day.
- Health checks are skipped under a prefix too (`/api/v1/health`). They were 27% of a Strapi
  API's `http.request` lines.
- Skipped paths are logged again when they fail with a 5xx, so a failing health check is visible.

## 0.4.6

Fixed:
- Types resolve for projects using `"moduleResolution": "node"` (node10), such as Strapi
  projects with `"module": "CommonJS"`. That mode ignores `exports`, so the package now also
  declares `main`, `module`, `types` and `typesVersions` for every subpath.

## 0.4.5

Changed:
- `logProcessWarnings` raises `Error.stackTraceLimit` to 30 (option `stackTraceLimit`; it never
  lowers it). In production, a pg deprecation's 10 default frames were all knex and Strapi
  internals, so the app code that caused it was not visible.

## 0.4.4

Added:
- `logProcessWarnings(log)`: logs Node process warnings (for example pg's "client.query() while
  executing" deprecation) as `process.warning` lines. Their `err_stack` points at the code
  that triggered the warning. `registerNext` installs it.

## 0.4.3

Fixed:
- `patchConsole` drops console calls that carry an error already written on a summary line, so a
  failed request is not logged twice.
- The Strapi transport honours the winston logger's runtime level. Strapi's data export and
  import commands set it to `error` to keep their output quiet.

Added:
- `patchConsole(log, { skip })`.
- `nextConsoleSkip` (`/next`): drops Next's console copy of a render error, which
  `onRequestError` logs with route and digest.

## 0.4.2

Fixed:
- `withLogging` resolves to the handler's own response type (for example `NextResponse` with
  `.cookies`) instead of plain `Response`.
- `package.json` is listed in `exports`, so tools that read it can resolve it.

## 0.4.1

Fixed:
- `withLogging` now returns a function with exactly the handler's parameters (`()`, `(request)`
  or `(request, { params })`), so Next.js route type checks accept the wrapped export. When it is
  called without a request (a direct call in a unit test), it runs the handler without logging.

## 0.4.0

Added:
- `@tanngo11/log/strapi` for Strapi 5:
  - `strapiLoggerConfig(log)` for `config/logger.ts`, so `strapi.log.*` becomes contract JSON;
  - `strapiRequestLogger`, which replaces `strapi::logger` and writes one `http.request` line per
    request;
  - `strapiErrorCapture`, which makes an unhandled error appear once instead of twice.
- `upstream_request_id`: the caller's request id when the service issues its own id.

## 0.3.0

Added:
- `@tanngo11/log/prisma`: `prismaLogging(log)` Prisma Client extension (Prisma 5 and 6). Logs
  `db.slow_query` with model, operation, rows and duration, and optionally `db.error`. It never
  logs SQL or arguments. Tested against a real Prisma client on SQLite.
- Custom redaction: `redactKeys` accepts RegExp, `redactValues` masks value patterns in every
  string, and the `redact(key, value)` hook can replace or drop fields. Opt-in
  `REDACT_PATTERNS`: `phoneVN`, `paymentCard`, `ipv4`.
- NestJS on the Fastify adapter. `setupNestLogging(app, log)` configures either adapter in one
  call.

## 0.2.0

Breaking:
- `installProcessHandlers` no longer listens to SIGTERM/SIGINT. Call `logShutdown(log)` from your
  own shutdown handler to log `app.stopping`. The old behavior could kill an app in the middle of
  its graceful shutdown.
- On a crash the exit is deferred (`exitDelayMs`, default 1000 ms), so other crash handlers
  (Sentry, APM) still run.
- When the route is unknown, the `http.request` message is `"<METHOD> <status>"` (no raw path).

Fixes:
- Secrets were not redacted inside arrays, objects nested deeper than 3 levels, or non-error `err`
  values. Camel-case keys were not redacted when `snakeCase: false`.
- Many secret key names were missing: connection strings, DSNs, JWTs, session ids, credentials.
  Keys are now matched on any snake_case part.
- Credentials in URLs, Bearer tokens, JWTs and emails are masked inside any string.
- `withLogging` accepts handlers typed with `NextRequest`. Non-object throws are logged once.
- Express keeps the mount prefix in `http_route` when a sub-router fails.
- `addContext` / `recordError` inside nested contexts reach the request's summary line.
- Fastify logs `499` when the client aborts.
- `NestLogger` keeps extra arguments (objects become fields, others go to `nest_args`).
- `loggedProcessor` forwards all BullMQ arguments and logs `UnrecoverableError` at error level.

Added:
- `patchConsole(log)`: routes `console.*` through the logger.
- `withAction`: wraps a Next.js server action (`action.completed` / `action.failed`).
- `jobData(data)`: adds the current `request_id` to a job payload.
- `logShutdown(log)`.

## 0.1.0

- Core logger implementing log contract v1: normalization, redaction, size limits, async context.
- Adapters: Express, Fastify, NestJS, Next.js (route handlers, onRequestError, edge request id), BullMQ.
- Helpers: createFetch (http.outbound), runJob (job.*), process lifecycle (app.*).
