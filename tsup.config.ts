import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    express: "src/express.ts",
    fastify: "src/fastify.ts",
    nest: "src/nest.ts",
    next: "src/next.ts",
    "next-edge": "src/next-edge.ts",
    bullmq: "src/bullmq.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  external: ["rxjs", "express", "fastify", "@nestjs/common"],
});
