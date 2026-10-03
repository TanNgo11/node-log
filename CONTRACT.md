# Log contract v1

The rules every server-side service follows so its logs read the same way to people and to AI
agents. `@tanngo11/log` implements them for Node. Services in other languages can follow them by
hand.

Assumed pipeline: container stdout → Vector (adds metadata, redacts secrets) → OpenObserve (one
stream, nested fields flattened with `_`) → MCP for AI agents.

## 1. Output format

1. **One JSON object per line on stdout or stderr.** Do not write log files, and do not send logs
   over HTTP from the app. Logs must pass through the redaction step on the host.
2. **No multi-line output.** The stack trace goes in `err_stack` on the same line.
3. **Flat snake_case fields.** Values are only strings, numbers or booleans. Group related fields
   with a prefix (`http_`, `err_`, `db_`, `job_`). Turn arrays into counts or ids.
4. **Do not rely on an app timestamp.** The collector sets the time.
5. **Reserved names.** The collector sets or overwrites these, so apps never use them:
   `project`, `service`, `vps`, `version`, `container_name`, `container_id`, `image`, `stream`,
   `_timestamp`, `label`, `host`, `source_type`, `msg`, `lvl`, `severity`. To rename a
   project or service, use the Docker labels `log.project` / `log.service`.
6. **Size limits:**
   - the whole line ≤ 16 KB, because Docker splits longer lines and the JSON breaks;
   - `message` ≤ 500 characters;
   - `err_stack` ≤ 4000 characters;
   - other strings ≤ 1000 characters.

## 2. Standard fields

| Group | Fields |
|---|---|
| Core | `level` (`trace\|debug\|info\|warn\|error\|fatal`), `message`, `event` (required for warn/error/fatal) |
| Correlation | `request_id`, `trace_id`, `span_id`, `job_name`, `job_id`, `job_attempt`, `user_id` (internal id, never an email), `tenant_id` |
| Inbound HTTP | `http_method`, `http_route` (template, e.g. `/orders/:id`), `http_path` (no query string), `http_status`, `duration_ms` |
| Outbound HTTP | `peer_service`, `http_method`, `http_url` (no query string or credentials), `http_status`, `duration_ms` |
| Error | `err_type`, `err_message`, `err_code` (string), `err_stack`, `err_cause` (cause chain joined with ` <- `, max 5) |
| Database | `db_system`, `db_operation`, `db_table`, `db_rows`, `duration_ms`, `db_statement` (parameterized only) |

Naming rules for domain fields:
- ids: `<entity>_id`;
- durations: `*_ms`;
- sizes: `*_bytes`;
- counts: `*_count`;
- booleans: `is_*` / `has_*`;
- money: `amount_minor` (integer, smallest unit) + `currency`.

A concept has one name in every service.

## 3. Levels

| Level | Use for |
|---|---|
| `fatal` | The process cannot continue and is about to exit. |
| `error` | An operation failed and someone must investigate: a 5xx response, or a job that has used up its retries. |
| `warn` | Something unusual that was handled, or a client error: 4xx, retry, fallback, a slow query or call. |
| `info` | Lifecycle and business events: request summaries, start/stop, a job done, an order created. |
| `debug` / `trace` | Diagnostics. Off in production. |

- Invalid user input is never `error`.
- `LOG_LEVEL` controls the level and defaults to `info`.

## 4. `event` and `message`

- `event` names are `<domain>.<action>`: lowercase, past tense for things that happened, for
  example `order.created` or `payment.failed`.
- Once an `event` name is used, never rename it.
- `message` is a **constant** English phrase. Variables go in fields, not in the text.
- Two exceptions:
  - `http.request` uses `"<METHOD> <route template> <status>"`, or `"<METHOD> <status>"` when the
    route is unknown. It never contains the raw path.
  - `console` lines (legacy `console.*` calls routed through the logger) keep the original text.

System events shared by all services:

| Event | Level | When |
|---|---|---|
| `app.started` | info | ready to serve (with `runtime_version`, `log_level`, `port`) |
| `app.stopping` | info | the app starts its own graceful shutdown |
| `app.crashed` | fatal | uncaught error, process exits |
| `app.unhandled_error` | error | uncaught error, process keeps running |
| `config.invalid` | fatal | missing or invalid config at startup (never log the value) |
| `http.request` | by status | one summary line per inbound request |
| `http.outbound` | warn | an outbound call failed (network error or 5xx) or was slow (≥ 1 s) |
| `db.slow_query` | warn | a query took longer than the threshold (default 500 ms) |
| `db.error` | error | a database error that no upper layer handles |
| `job.started` / `job.completed` | info | job lifecycle |
| `job.failed` | warn if retries remain, error on the final attempt or a non-retryable error | job error |
| `action.completed` | info | a server action finished, including a redirect or not-found (with `action_name`, `duration_ms`) |
| `action.failed` | error | a server action threw |
| `console` | by console method | a legacy `console.*` call (with `console_method`) |

## 5. What to log

**Required:**
- `app.started` and `app.stopping`.
- One `http.request` line per request: 5xx at `error`, 4xx at `warn`, otherwise `info`. Skip
  health checks, static assets and `OPTIONS`.
- **Log each error once, at the boundary.** Code that rethrows does not log. A failed request
  produces one `error` line: its `http.request` line, carrying `err_*`.
- `job.completed` / `job.failed` with `job_name`, `job_id` and `duration_ms`.
- Outbound calls that fail or are slow.
- Important business events, with entity ids.

**Never log:**
- secrets: passwords, tokens, API keys, cookies, `Authorization` headers, connection strings;
- request or response bodies;
- query strings;
- personal data: email, phone, name, address, ID numbers, IP address, full user agent;
- card or bank numbers;
- SQL with its parameter values;
- dumps of environment variables.

## 6. Correlation

- Reuse an incoming `x-request-id` if it is valid (≤ 64 characters, `[A-Za-z0-9._-]`).
  Otherwise generate a UUID v4. Return it as a response header.
- Parse W3C `traceparent` into `trace_id` and `span_id`. Do not invent trace ids.
- Forward `x-request-id` and `traceparent` to services you own, never to third parties.
- A job enqueued from a request carries that request's `request_id` in its payload.
- Every log line inside a request or job gets these fields from async context, without being
  passed by hand.

## 7. Compliance levels

| Level | Requires |
|---|---|
| L1 | JSON lines, a textual `level`, `message`, no reserved names, no secrets or personal data |
| L2 | L1 + `request_id` on every line of a request, the `http.request` line, `err_*` on failures, `event` on warn/error/fatal |
| L3 | L2 + `http.outbound`, `job.*`, header propagation, constant messages |

## 8. Versioning

- Adding fields or events keeps version v1.
- Renaming a field or changing its meaning needs a v2, with migration notes, and a major release
  of the library.
