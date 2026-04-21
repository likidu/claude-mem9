import { describe, test, expect, beforeAll } from "bun:test";
import { Mem9Manager } from "../../../src/services/mem9/Mem9Manager";

const MEM9_URL = process.env.MEM9_URL;

describe.skipIf(!MEM9_URL)("mem9 integration: session lifecycle", () => {
  let mgr: Mem9Manager;
  beforeAll(() => { mgr = new Mem9Manager(); });

  test("creates session, updates prompt counter, completes", async () => {
    const started = Math.floor(Date.now() / 1000);
    const session = {
      id: `sess-it-${started}`,
      content_session_id: "c-it",
      memory_session_id: `m-it-${started}`,
      project: "mem9-it",
      status: "active",
      platform_source: "test",
      started_at_epoch: started,
      completed_at_epoch: null,
      worker_port: 37777,
      prompt_counter: 0,
    };
    const id = await mgr.store.storeSession(session);
    expect(id).toBeString();

    await mgr.store.updateSession(id, { prompt_counter: 5 });
    await mgr.store.updateSession(id, { status: "completed", completed_at_epoch: started + 60 });

    // verify via direct client get
    const mem = await mgr.client.get(id);
    expect((mem.metadata as any).status).toBe("completed");
    expect((mem.metadata as any).prompt_counter).toBe(5);
  });
});
