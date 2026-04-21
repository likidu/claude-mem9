import { describe, test, expect } from "bun:test";
import { Mem9Search } from "../../src/services/mem9/Mem9Search";
import type { Mem9Client, Mem9Memory } from "../../src/services/mem9/Mem9Client";

function memory(id: string, metadata: Record<string, unknown>, tags: string[] = []): Mem9Memory {
  return { id, content: "", tags, metadata, memory_type: "observation", source: (metadata.project as string) ?? "" };
}

function fakeClient(pages: Mem9Memory[][]): Mem9Client {
  let call = 0;
  return {
    async search() { return pages[call++] ?? []; },
    async get(id: string) { return memory(id, {}, []); },
  } as any;
}

describe("Mem9Search.searchObservations", () => {
  test("filters server-side by kind + project, dedupes by parent_id", async () => {
    const parentA = memory("a", { kind: "observation", project: "demo" });
    const parentB = memory("b", { kind: "observation", project: "demo" });
    const field1 = memory("f1", { kind: "field_narrative", parent_id: "a" }, ["parent:a"]);
    const field2 = memory("f2", { kind: "field_fact", parent_id: "a" }, ["parent:a"]);
    const field3 = memory("f3", { kind: "field_fact", parent_id: "b" }, ["parent:b"]);
    const client = fakeClient([[parentA, field1, field2, parentB, field3]]);
    const search = new Mem9Search(client);
    const out = await search.searchObservations({ query: "x", project: "demo", limit: 10 });
    // after dedup there should be two parents
    expect(out.length).toBe(2);
    expect(out.map((o) => o.id).sort()).toEqual(["a", "b"]);
  });

  test("applies client-side time-range post-filter", async () => {
    const old = memory("old", { kind: "observation", project: "demo", created_at_epoch: 50 });
    const recent = memory("new", { kind: "observation", project: "demo", created_at_epoch: 500 });
    const client = fakeClient([[old, recent]]);
    const search = new Mem9Search(client);
    const out = await search.searchObservations({
      project: "demo", createdAfter: 100, limit: 10,
    });
    expect(out.map((o) => o.id)).toEqual(["new"]);
  });
});
