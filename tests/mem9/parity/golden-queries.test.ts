import { describe, test, expect, beforeAll } from "bun:test";
import { Mem9Manager } from "../../../src/services/mem9/Mem9Manager";
import fixtures from "./fixtures.json";

const MEM9_URL = process.env.MEM9_URL;
const RUN_PARITY = process.env.RUN_PARITY === "1";

describe.skipIf(!MEM9_URL || !RUN_PARITY)("mem9 parity: golden queries", () => {
  let mgr: Mem9Manager;
  beforeAll(() => { mgr = new Mem9Manager(); });

  for (const q of fixtures.queries) {
    test(`returns results for ${JSON.stringify(q)}`, async () => {
      const results = await mgr.search.searchObservations({ ...q, limit: 10 });
      expect(results.length).toBeGreaterThan(0); // baseline: non-empty
      // manual: run once with legacy, once with mem9, diff top-10 by id
    });
  }
});
