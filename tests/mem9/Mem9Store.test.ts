import { describe, test, expect } from "bun:test";
import { Mem9Store } from "../../src/services/mem9/Mem9Store";
import type { Mem9Client, StoreInput } from "../../src/services/mem9/Mem9Client";

function makeClient(): {
  client: Mem9Client;
  calls: { store: StoreInput[]; deletes: string[] };
  nextId: (id: string) => void;
  failNext: (n: number) => void;
} {
  const calls = { store: [] as StoreInput[], deletes: [] as string[] };
  const ids: string[] = [];
  let failures = 0;
  const client: Partial<Mem9Client> = {
    async store(input: StoreInput) {
      calls.store.push(input);
      if (failures > 0) { failures--; throw new Error("boom"); }
      return ids.shift() ?? `mem-${calls.store.length}`;
    },
    async delete(id: string) {
      calls.deletes.push(id);
    },
  };
  return {
    client: client as Mem9Client,
    calls,
    nextId: (id) => ids.push(id),
    failNext: (n) => { failures = n; },
  };
}

const OBS = {
  id: "obs-1", memory_session_id: "s1", project: "demo", type: "discovery",
  title: "T", subtitle: "S", narrative: "N", facts: ["a", "b"], concepts: [],
  files_read: [], files_modified: [], created_at_epoch: 1,
  prompt_number: 1, discovery_tokens: 0, content_hash: "h",
  merged_into_project: null, agent_type: null, agent_id: null,
};

describe("Mem9Store.storeObservation", () => {
  test("stores parent then N field memories in parallel and returns parent id", async () => {
    const { client, calls, nextId } = makeClient();
    nextId("parent-id");
    const store = new Mem9Store(client);
    const id = await store.storeObservation(OBS);
    expect(id).toBe("parent-id");
    // 1 parent + 3 fields (narrative + 2 facts)
    expect(calls.store.length).toBe(4);
    // first call is parent
    expect(calls.store[0].memory_type).toBe("observation");
    // subsequent calls carry parent tag
    for (const c of calls.store.slice(1)) {
      expect(c.tags.some((t) => t.startsWith("parent:"))).toBe(true);
    }
  });

  test("rolls back parent if any field store fails", async () => {
    const { client, calls, failNext, nextId } = makeClient();
    nextId("parent-roll");
    // parent succeeds, then one field fails
    failNext(1);
    // note: failNext applies on the *next* store call. We want the parent to succeed,
    // so we call failNext after the first store succeeds — easier: just make failNext trigger
    // on the 2nd call by preloading 0 failures here and skipping the first. We'll instead
    // use a counter in the fake client that fails the 2nd call.
    // Adjust: recreate client with targeted failure
    const seq = makeClient();
    let i = 0;
    (seq.client.store as any) = async (input: StoreInput) => {
      seq.calls.store.push(input);
      i++;
      if (i === 2) throw new Error("field failed");
      return `mem-${i}`;
    };
    const store = new Mem9Store(seq.client);
    await expect(store.storeObservation(OBS)).rejects.toThrow(/field failed/);
    expect(seq.calls.deletes).toEqual(["mem-1"]); // parent rolled back
  });
});

describe("Mem9Store.updateSession", () => {
  test("sends only known field patches through metadata", async () => {
    const calls: { id: string; patch: any }[] = [];
    const client = {
      async update(id: string, patch: any) {
        calls.push({ id, patch });
      },
    } as unknown as Mem9Client;
    const store = new Mem9Store(client);

    await store.updateSession("sess-1", {
      status: "completed",
      completed_at_epoch: 999,
      prompt_counter: 7,
      // unknown fields — should be dropped silently
      project: "ignored",
      worker_port: 1234,
    } as any);

    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe("sess-1");
    expect(calls[0].patch).toEqual({
      metadata: {
        status: "completed",
        completed_at_epoch: 999,
        prompt_counter: 7,
      },
    });
  });

  test("undefined fields are not emitted in the patch", async () => {
    const calls: { patch: any }[] = [];
    const client = {
      async update(_: string, patch: any) { calls.push({ patch }); },
    } as unknown as Mem9Client;
    const store = new Mem9Store(client);

    await store.updateSession("sess-2", { status: "completed" });

    expect(calls[0].patch).toEqual({ metadata: { status: "completed" } });
  });
});
