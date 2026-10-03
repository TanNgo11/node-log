import { AsyncLocalStorage } from "node:async_hooks";
import { globalSingleton } from "./global";
import type { Fields } from "./normalize";

export interface ContextStore {
  fields: Fields;
  error?: unknown;
  /** Route template captured while the router still knew it (Express error path). */
  route?: string;
  parent?: ContextStore;
}

const als = globalSingleton("als", () => new AsyncLocalStorage<ContextStore>());

export const STORE_KEY: symbol = Symbol.for("@tanngo11/log.store");

export function runWithStore<T>(fields: Fields, fn: (store: ContextStore) => T): T {
  const parent = als.getStore();
  const store: ContextStore = { fields: { ...parent?.fields, ...fields }, parent };
  return als.run(store, () => fn(store));
}

export function withContext<T>(fields: Fields, fn: () => T): T {
  return runWithStore(fields, () => fn());
}

export function currentStore(): ContextStore | undefined {
  return als.getStore();
}

export function getContext(): Fields {
  return als.getStore()?.fields ?? {};
}

// Applies to the current context and every enclosing one, so a field added inside a nested
// withContext/runJob still reaches the request's http.request line.
export function addContext(fields: Fields): void {
  for (let s = als.getStore(); s; s = s.parent) Object.assign(s.fields, fields);
}

// Sets the error on the store and on enclosing stores that have none yet.
export function recordErrorIn(store: ContextStore, err: unknown): void {
  store.error = err;
  for (let s = store.parent; s; s = s.parent) if (s.error === undefined) s.error = err;
}

// Marks the error that the current request/job summary line should carry. Does not write a line.
export function recordError(err: unknown): void {
  const store = als.getStore();
  if (store) recordErrorIn(store, err);
}

export function attachStore(target: object, store: ContextStore): void {
  (target as Record<symbol, ContextStore>)[STORE_KEY] = store;
}

export function storeOf(target: unknown): ContextStore | undefined {
  if (typeof target !== "object" || target === null) return undefined;
  return (target as Record<symbol, ContextStore | undefined>)[STORE_KEY];
}
