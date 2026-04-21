import { describe, test, expect, beforeAll } from "bun:test";
import { Mem9Manager } from "../../../src/services/mem9/Mem9Manager";

const MEM9_URL = process.env.MEM9_URL;

describe.skipIf(!MEM9_URL)("mem9 integration: write-read roundtrip", () => {
  let mgr: Mem9Manager;
  beforeAll(() => { mgr = new Mem9Manager(); });

  test("stores an observation and finds it by project", async () => {
    const obs = {
      id: `it-${Date.now()}`,
      memory_session_id: "it-session",
      project: "mem9-it",
      type: "test",
      title: "Roundtrip",
      subtitle: "sub",
      narrative: "the narrative body",
      facts: ["integration fact one"],
      concepts: [],
      files_read: [],
      files_modified: [],
      created_at_epoch: Math.floor(Date.now() / 1000),
      prompt_number: 1,
      discovery_tokens: 0,
      content_hash: null,
      merged_into_project: null,
      agent_type: null,
      agent_id: null,
    };
    const parentId = await mgr.store.storeObservation(obs);
    expect(parentId).toBeString();

    // search with the narrative text — should find via FTS
    const results = await mgr.search.searchObservations({
      query: "narrative body",
      project: "mem9-it",
      limit: 5,
    });
    expect(results.some((r) => r.id === parentId)).toBe(true);
  });
});
