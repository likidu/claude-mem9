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

import {
  summaryToMemory, memoryToSummary,
  promptToMemory, memoryToPrompt,
  sessionToMemory, memoryToSession,
  feedbackToMemory, memoryToFeedback,
  pendingMessageToMemory, memoryToPendingMessage,
} from "../../src/services/mem9/mapping";

describe("summary mapping", () => {
  const summary = {
    id: "sum-1",
    memory_session_id: "s1",
    project: "demo",
    request: "q",
    investigated: "i",
    learned: "l",
    completed: "c",
    next_steps: "n",
    files_read: ["a"],
    files_edited: ["b"],
    notes: "notes",
    created_at_epoch: 5,
    prompt_number: 2,
    discovery_tokens: 1,
    merged_into_project: null,
  };
  test("round-trips", () => {
    const mem = { id: "sum-1", ...summaryToMemory(summary) } as any;
    expect(memoryToSummary(mem)).toEqual(summary);
  });
});

describe("user_prompt mapping", () => {
  const p = {
    id: "p-1",
    content_session_id: "c1",
    prompt_text: "hello",
    prompt_number: 3,
    created_at_epoch: 10,
  };
  test("round-trips", () => {
    const mem = { id: "p-1", ...promptToMemory(p) } as any;
    expect(memoryToPrompt(mem)).toEqual(p);
  });
});

describe("session mapping", () => {
  const s = {
    id: "sess-1", content_session_id: "c1", memory_session_id: "m1",
    project: "demo", status: "active", platform_source: "claude-code",
    started_at_epoch: 1, completed_at_epoch: null, worker_port: 37777, prompt_counter: 0,
  };
  test("round-trips", () => {
    const mem = { id: "sess-1", ...sessionToMemory(s) } as any;
    expect(memoryToSession(mem)).toEqual(s);
  });
});

describe("feedback mapping", () => {
  const f = { observation_id: "obs-1", rating: 5, tags: ["useful"] };
  test("round-trips", () => {
    const mem = { id: "fb-1", ...feedbackToMemory(f) } as any;
    const back = memoryToFeedback(mem);
    expect(back.observation_id).toBe("obs-1");
    expect(back.rating).toBe(5);
    expect(back.tags).toEqual(["useful"]);
  });
});

describe("pending_message mapping", () => {
  const pm = { session_id: "sess-1", pending_count: 3, last_check_epoch: 100 };
  test("round-trips", () => {
    const mem = { id: "pm-1", ...pendingMessageToMemory(pm) } as any;
    expect(memoryToPendingMessage(mem)).toEqual(pm);
  });
});
