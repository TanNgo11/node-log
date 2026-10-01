import type { CallHandler, ExecutionContext, LoggerService, NestInterceptor } from "@nestjs/common";
import { catchError, throwError, type Observable } from "rxjs";
import { currentStore, recordError, recordErrorIn, storeOf } from "./context";
import type { Level } from "./levels";
import type { Logger } from "./logger";
import type { Fields } from "./normalize";

export { requestLogger } from "./express";

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
