import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

// Generates the test Prisma client and a fresh throwaway SQLite file (both git-ignored).
export default function setup(): void {
  const schema = "test/prisma/schema.prisma";
  execSync(`npx prisma generate --schema ${schema}`, { stdio: "ignore" });
  for (const f of ["test/prisma/test.db", "test/prisma/test.db-journal"]) rmSync(f, { force: true });
  execSync(`npx prisma db push --schema ${schema} --skip-generate`, { stdio: "ignore" });
}
