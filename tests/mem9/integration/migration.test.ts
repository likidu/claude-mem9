import { describe, test, expect } from "bun:test";
import { runMigrateToMem9 } from "../../../src/cli/migrate-to-mem9-command";

const MEM9_URL = process.env.MEM9_URL;
const RUN_MIGRATION = process.env.RUN_MIGRATION === "1";

describe.skipIf(!MEM9_URL || !RUN_MIGRATION)("mem9 integration: migration", () => {
  test("migrates existing SQLite DB without throwing", async () => {
    await expect(runMigrateToMem9()).resolves.toBeUndefined();
  });
});
