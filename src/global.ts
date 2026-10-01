// Singletons shared by every copy of this package loaded in the process (ESM and CJS builds,
// or duplicated installs), so context and dedupe state never split.
export function globalSingleton<T>(name: string, make: () => T): T {
  const key = Symbol.for(`@tanngo11/log.${name}`);
  const g = globalThis as unknown as Record<symbol, T | undefined>;
  let value = g[key];
  if (value === undefined) {
    value = make();
    g[key] = value;
  }
  return value;
}
