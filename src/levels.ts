export const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type Level = (typeof LEVELS)[number];

export const LEVEL_RANK: Record<Level, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const ALIASES: Record<string, Level> = { warning: "warn", err: "error", critical: "fatal", panic: "fatal" };

export function parseLevel(value: unknown, fallback: Level = "info"): Level {
  if (typeof value !== "string") return fallback;
  const v = value.trim().toLowerCase();
  if ((LEVELS as readonly string[]).includes(v)) return v as Level;
  return ALIASES[v] ?? fallback;
}
