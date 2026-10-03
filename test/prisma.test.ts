import { describe, expect, it } from "vitest";
import { withContext } from "../src/context";
import { prismaLogging } from "../src/prisma";
import { capture } from "./helpers";
import { PrismaClient } from "./prisma/client";

describe("prismaLogging", () => {
  it("logs db.slow_query with table, operation and rows, never SQL or params", async () => {
    const { log, lines } = capture();
    const prisma = new PrismaClient().$extends(prismaLogging(log, { slowMs: 0, db_system: "sqlite" }));
    await withContext({ request_id: "r1" }, async () => {
      await prisma.order.create({ data: { code: "A-1", total: 100 } });
      await prisma.order.findMany({ where: { total: { gt: 0 } } });
      await prisma.$queryRaw`SELECT 1`;
    });
    const out = lines();
    expect(out[0]).toMatchObject({ level: "warn", event: "db.slow_query", db_system: "sqlite", db_operation: "create", db_table: "Order", request_id: "r1" });
    expect(out[1]).toMatchObject({ db_operation: "findMany", db_table: "Order", db_rows: 1 });
    expect(out[2]).toMatchObject({ db_operation: "$queryRaw" });
    expect(out[2]!.db_table).toBeUndefined();
    expect(JSON.stringify(out)).not.toMatch(/A-1|SELECT/);
    await prisma.$disconnect();
  });
  it("stays quiet below the threshold and does not log errors unless asked", async () => {
    const { log, lines } = capture();
    const prisma = new PrismaClient().$extends(prismaLogging(log));
    await prisma.order.findMany();
    await expect(prisma.order.create({ data: { code: "A-1", total: 1 } })).rejects.toMatchObject({ code: "P2002" });
    expect(lines()).toHaveLength(0);
    const loud = new PrismaClient().$extends(prismaLogging(log, { logErrors: true }));
    await expect(loud.order.create({ data: { code: "A-1", total: 1 } })).rejects.toThrow();
    expect(lines()[0]).toMatchObject({ level: "error", event: "db.error", db_operation: "create", db_table: "Order", err_code: "P2002" });
    await prisma.$disconnect();
    await loud.$disconnect();
  });
});
