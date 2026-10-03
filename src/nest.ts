import type { CallHandler, ExecutionContext, LoggerService, NestInterceptor } from "@nestjs/common";
import { catchError, throwError, type Observable } from "rxjs";
import { currentStore, recordError, recordErrorIn, storeOf } from "./context";
import { requestLogger as expressRequestLogger } from "./express";
import { fastifyLogger } from "./fastify";
import type { HttpLogOptions } from "./http";
import type { Level } from "./levels";
import type { Logger } from "./logger";
import type { Fields } from "./normalize";

export { requestLogger } from "./express";
export { fastifyLogger } from "./fastify";

const STACK_RE = /\n\s+at /;

/** Routes Nest's own logs (bootstrap, ExceptionsHandler, Logger calls) into the JSON logger. */
export class NestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.emit("info", message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.emit("error", message, params);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.emit("warn", message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.emit("debug", message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.emit("trace", message, params);
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.emit("fatal", message, params);
  }

  private emit(level: Level, message: unknown, params: unknown[]): void {
    const rest = [...params];
    const last = rest[rest.length - 1];
    const nestContext = typeof last === "string" && !STACK_RE.test(last) ? (rest.pop() as string) : undefined;
    const stack = typeof rest[0] === "string" && STACK_RE.test(rest[0]) ? (rest.shift() as string) : undefined;

    // Nest's ExceptionsHandler logs unhandled errors; the http.request line already carries
    // them, so hand the error to the request instead of writing a second error line.
    const store = currentStore();
    if (nestContext === "ExceptionsHandler" && store?.fields.request_id !== undefined) {
      if (store.error === undefined) {
        const e = message instanceof Error ? message : Object.assign(new Error(String(message)), { stack });
        recordErrorIn(store, e);
      }
      return;
    }

    const fields: Fields = { nest_context: nestContext };
    // Extra arguments: objects become fields, errors become err, anything else goes to nest_args.
    const extras: unknown[] = [];
    for (const arg of rest) {
      if (arg instanceof Error && fields.err === undefined) fields.err = arg;
      else if (typeof arg === "object" && arg !== null && !Array.isArray(arg)) Object.assign(fields, arg);
      else extras.push(arg);
    }
    if (extras.length > 0) fields.nest_args = extras;
    let text: string;
    if (message instanceof Error) {
      fields.err = message;
      text = message.message;
    } else if (typeof message === "object" && message !== null) {
      fields.nest_payload = message;
      text = "nest log";
    } else {
      text = String(message);
    }
    if (stack !== undefined) fields.err_stack = stack;
    this.logger[level](text, fields);
  }
}

/** Records request errors for the http.request line, then rethrows to Nest's exception filters. */
export class ErrorRecorderInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((err: unknown) => {
        const store = storeOf(context.switchToHttp().getResponse());
        if (store) recordErrorIn(store, err);
        else recordError(err);
        return throwError(() => err);
      }),
    );
  }
}


/** The parts of a Nest application that setupNestLogging needs, for either HTTP adapter. */
export interface NestAppLike {
  getHttpAdapter(): { getType(): string };
  useGlobalInterceptors(...interceptors: NestInterceptor[]): unknown;
  use?(...args: unknown[]): unknown;
  register?(...args: unknown[]): Promise<unknown>;
}

/**
 * One-call setup for Express and Fastify Nest apps: request context, the http.request line and
 * error recording. Call before `app.listen()`.
 */
export async function setupNestLogging(app: NestAppLike, log: Logger, opts: HttpLogOptions = {}): Promise<void> {
  const type = app.getHttpAdapter().getType();
  if (type === "fastify") {
    if (!app.register) throw new Error("setupNestLogging: Fastify app has no register()");
    await app.register(fastifyLogger, { ...opts, log });
  } else {
    if (!app.use) throw new Error("setupNestLogging: app has no use()");
    app.use(expressRequestLogger(log, opts));
  }
  app.useGlobalInterceptors(new ErrorRecorderInterceptor());
}
