import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const entries = ["index", "express", "fastify", "nest", "next", "next-edge", "bullmq", "prisma", "strapi"];
const require = createRequire(import.meta.url);
const dist = (name: string, ext: string) => fileURLToPath(new URL(`../dist/${name}.${ext}`, import.meta.url));
const importDist = (name: string) => import(/* @vite-ignore */ pathToFileURL(dist(name, "js")).href);

describe("built package", () => {
  beforeAll(() => {
    execSync("npx tsup", { stdio: "ignore" });
  }, 120_000);

  it.each(entries)("loads dist/%s via ESM and CJS with the same exports", async (name) => {
    const esm = await importDist(name);
    const cjs = require(dist(name, "cjs"));
    expect(Object.keys(esm).length).toBeGreaterThan(0);
    expect(Object.keys(cjs).sort()).toEqual(Object.keys(esm).filter((k) => k !== "default").sort());
  });

  it("shares context between the ESM and CJS builds", async () => {
    const esm = await importDist("index");
    const cjs = require(dist("index", "cjs"));
    await esm.withContext({ request_id: "shared" }, async () => {
      expect(cjs.getContext()).toEqual({ request_id: "shared" });
    });
  });
});
