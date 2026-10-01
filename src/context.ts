import { AsyncLocalStorage } from "node:async_hooks";
import { globalSingleton } from "./global";
import type { Fields } from "./normalize";

export interface ContextStore {
  fields: Fields;
  error?: unknown;
}

const als = globalSingleton("als", () => new AsyncLocalStorage<ContextStore>());

export const STORE_KEY: symbol = Symbol.for("@tanngo11/log.store");

export function runWithStore<T>(fields: Fields, fn: (store: ContextStore) => T): T {
  const parent = als.getStore();
  const store: ContextStore = { fields: { ...parent?.fields, ...fields } };
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

export function addContext(fields: Fields): void {
  const store = als.getStore();
  if (store) Object.assign(store.fields, fields);
}

export function recordErrorIn(store: ContextStore, err: unknown): void {
  store.error = err;
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
