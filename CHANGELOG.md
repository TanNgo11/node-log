# Changelog

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
