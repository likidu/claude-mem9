import { describe, test, expect } from "bun:test";
import {
  observationToMemories,
  memoriesToObservation,
  FIELD_MEMORY_KINDS,
} from "../../src/services/mem9/mapping";

const SAMPLE_OBS = {
  id: "obs-1",
  memory_session_id: "sess-1",
  project: "demo",
  type: "discovery",
  title: "A thing happened",
  subtitle: "Subtitle",
  narrative: "The long narrative.",
  facts: ["fact one", "fact two"],
  concepts: ["c1"],
  files_read: ["a.ts"],
  files_modified: ["b.ts"],
  created_at_epoch: 123,
  prompt_number: 1,
  discovery_tokens: 42,
  content_hash: "hash",
  merged_into_project: null,
  agent_type: "primary",
  agent_id: "agent-1",
};

describe("observationToMemories", () => {
  test("produces 1 parent + N field memories with parent tag", () => {
    const out = observationToMemories(SAMPLE_OBS);
    expect(out.parent.tags).toContain("kind:observation");
    expect(out.parent.tags).toContain("project:demo");
    expect(out.parent.memory_type).toBe("observation");
    // fields: narrative + 2 facts + 1 concept = 4
    expect(out.fields.length).toBe(4);
    for (const f of out.fields) {
      expect(FIELD_MEMORY_KINDS).toContain(f.metadata.kind as string);
      // parent tag encoded for server-side filtering
      expect(f.tags.some((t) => t.startsWith("parent:"))).toBe(true);
    }
  });

  test("empty facts/concepts produce zero field memories for that kind", () => {
    const minimal = { ...SAMPLE_OBS, facts: [], concepts: [] };
    const out = observationToMemories(minimal);
    expect(out.fields.length).toBe(1); // just narrative
  });
});

describe("memoriesToObservation", () => {
  test("round-trips a parent + fields back to the original observation", () => {
    const { parent, fields } = observationToMemories(SAMPLE_OBS);
    // simulate server assigning ids
    const parentMem = { id: "parent-1", ...parent, tags: parent.tags, metadata: parent.metadata };
    const fieldMems = fields.map((f, i) => ({ id: `f-${i}`, ...f }));
    const obs = memoriesToObservation(parentMem as any, fieldMems as any);
    expect(obs.id).toBe("parent-1");
    expect(obs.narrative).toBe(SAMPLE_OBS.narrative);
    expect(obs.facts).toEqual(SAMPLE_OBS.facts);
    expect(obs.concepts).toEqual(SAMPLE_OBS.concepts);
    expect(obs.project).toBe(SAMPLE_OBS.project);
  });
});
