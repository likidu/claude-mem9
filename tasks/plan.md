# Mem9 Migration — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a feature-flagged mem9 backend alongside the existing SQLite+Chroma stack. When `MEM9_URL` is set, writes and reads go through a new `src/services/mem9/*` module; when unset, everything behaves exactly as today.

**Architecture:** New isolated `src/services/mem9/` module (client → store/search → manager) that mirrors the public shape of `SessionStore` + `SessionSearch` + `ChromaSync.queryChroma`. Feature-flag branches live in three hub points only: worker boot (`DatabaseManager`), write path (`ResponseProcessor`), read path (`SearchManager`). Legacy code is untouched in Phase 1.

**Tech Stack:** TypeScript (ESM), Bun runtime, `bun test`, Bun's built-in `fetch`. No new dependencies.

**Source spec:** `docs/superpowers/specs/2026-04-21-mem9-migration-design.md`

**Verified mem9 constraints (from source inspection, do not re-verify):**
- No bulk `memory_store` route mounted on mnemo-server. Fan-out writes via `Promise.all`.
- Filter surface is flat equality on a fixed struct plus `Tags` OR-list. Rich predicates become client-side post-filter.
- No native `parent_id`; encode as `tags: ["parent:<id>"]`.
- Filterable fields: `Query, Tags, Source, State, MemoryType, AgentID, SessionID, Limit, Offset, MinScore`.

**Invariants that must not break:**
- `<private>` tag stripping at the hook layer (`src/utils/tag-stripping.ts`) — do not move or reroute.
- Legacy path (MEM9_URL unset) is byte-identical to today's behavior.
- Worker exit code strategy per project `CLAUDE.md` (exit 0 for graceful shutdown, 2 for blocking errors).

---

## File Structure

### New files

- `src/services/mem9/config.ts` — loads `MEM9_URL`, `MEM9_API_KEY` from env + `~/.claude-mem/settings.json`.
- `src/services/mem9/errors.ts` — typed errors.
- `src/services/mem9/Mem9Client.ts` — thin REST wrapper.
- `src/services/mem9/mapping.ts` — entity ↔ memory converters.
- `src/services/mem9/Mem9Store.ts` — write API mirroring today's `SessionStore` surface.
- `src/services/mem9/Mem9Search.ts` — read API with two-pass over-fetch + post-filter.
- `src/services/mem9/healthcheck.ts` — boot-time probe.
- `src/services/mem9/Mem9Manager.ts` — lifecycle facade (mirrors `DatabaseManager`'s relevant surface).
- `src/cli/migrate-to-mem9-command.ts` — one-shot migration CLI.
- `tests/mem9/config.test.ts`
- `tests/mem9/Mem9Client.test.ts`
- `tests/mem9/mapping.test.ts`
- `tests/mem9/Mem9Store.test.ts`
- `tests/mem9/Mem9Search.test.ts`
- `tests/mem9/healthcheck.test.ts`
- `tests/mem9/integration/write-read-roundtrip.test.ts`
- `tests/mem9/integration/session-lifecycle.test.ts`
- `tests/mem9/integration/migration.test.ts`
- `tests/mem9/parity/golden-queries.test.ts`

### Modified files

- `src/services/DatabaseManager.ts` — add `getMem9Manager()` getter gated on `MEM9_URL`.
- `src/services/worker/agents/ResponseProcessor.ts` — write-path feature branch.
- `src/services/worker/SearchManager.ts` — read-path feature branch.
- `src/services/worker-service.ts` — boot-time healthcheck wiring.

---

## Task 1: Config module

**Why first:** every other module depends on `MEM9_URL` discovery. Pure I/O with no upstream deps.

**Files:**
- Create: `src/services/mem9/config.ts`
- Create: `tests/mem9/config.test.ts`

- [ ] **Step 1.1: Write the failing test**

Create `tests/mem9/config.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadMem9Config, isMem9Enabled } from "../../src/services/mem9/config";

describe("mem9 config", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.MEM9_URL;
    delete process.env.MEM9_API_KEY;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("isMem9Enabled returns false when MEM9_URL unset", () => {
    expect(isMem9Enabled()).toBe(false);
  });

  test("isMem9Enabled returns true when MEM9_URL set", () => {
    process.env.MEM9_URL = "http://localhost:8080";
    expect(isMem9Enabled()).toBe(true);
  });

  test("loadMem9Config returns URL and optional API key", () => {
    process.env.MEM9_URL = "http://localhost:8080";
    process.env.MEM9_API_KEY = "secret";
    const cfg = loadMem9Config();
    expect(cfg.url).toBe("http://localhost:8080");
    expect(cfg.apiKey).toBe("secret");
  });

  test("loadMem9Config throws when MEM9_URL unset", () => {
    expect(() => loadMem9Config()).toThrow(/MEM9_URL/);
  });

  test("loadMem9Config strips trailing slash from URL", () => {
    process.env.MEM9_URL = "http://localhost:8080/";
    expect(loadMem9Config().url).toBe("http://localhost:8080");
  });
});
```

- [ ] **Step 1.2: Run to verify it fails**

Run: `bun test tests/mem9/config.test.ts`
Expected: FAIL with "Cannot find module ... config"

- [ ] **Step 1.3: Implement `config.ts`**

Create `src/services/mem9/config.ts`:

```typescript
export interface Mem9Config {
  url: string;
  apiKey: string | undefined;
}

export function isMem9Enabled(): boolean {
  return typeof process.env.MEM9_URL === "string" && process.env.MEM9_URL.length > 0;
}

export function loadMem9Config(): Mem9Config {
  const raw = process.env.MEM9_URL;
  if (!raw) {
    throw new Error(
      "MEM9_URL is not set. Set MEM9_URL=http://your-mem9-server to enable the mem9 backend."
    );
  }
  return {
    url: raw.replace(/\/+$/, ""),
    apiKey: process.env.MEM9_API_KEY || undefined,
  };
}
```

- [ ] **Step 1.4: Run to verify it passes**

Run: `bun test tests/mem9/config.test.ts`
Expected: 5 pass, 0 fail.

- [ ] **Step 1.5: Commit**

```bash
git add src/services/mem9/config.ts tests/mem9/config.test.ts
git commit -m "feat(mem9): add config loader with MEM9_URL discovery"
```

---

## Task 2: Typed errors

**Why:** every downstream module throws these; defining them early prevents churn.

**Files:**
- Create: `src/services/mem9/errors.ts`

- [ ] **Step 2.1: Implement errors module**

Create `src/services/mem9/errors.ts`:

```typescript
export class Mem9Error extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "Mem9Error";
  }
}

export class Mem9Unavailable extends Mem9Error {
  constructor(url: string, cause?: unknown) {
    super(`mem9 server at ${url} is unreachable`, cause);
    this.name = "Mem9Unavailable";
  }
}

export class Mem9AuthError extends Mem9Error {
  constructor(cause?: unknown) {
    super("mem9 authentication failed — check MEM9_API_KEY", cause);
    this.name = "Mem9AuthError";
  }
}

export class Mem9NotFound extends Mem9Error {
  constructor(id: string) {
    super(`mem9 memory not found: ${id}`);
    this.name = "Mem9NotFound";
  }
}

export class Mem9BadRequest extends Mem9Error {
  constructor(message: string, public readonly body?: string) {
    super(`mem9 bad request: ${message}`);
    this.name = "Mem9BadRequest";
  }
}
```

- [ ] **Step 2.2: Commit**

No tests needed — these are data classes with no logic. The types are covered transitively by `Mem9Client` tests in Task 3.

```bash
git add src/services/mem9/errors.ts
git commit -m "feat(mem9): add typed error classes"
```

---

## Task 3: Mem9Client — store & get

**Why this shape:** client is the only module that touches `fetch`. Keeping HTTP concerns isolated means every other module is pure & easy to test with a mocked client. Split into two tasks (Task 3 = store+get, Task 4 = update+delete+search) to keep PRs bite-sized.

**One-time verification:** before writing code, confirm mnemo-server's single-memory POST payload shape. Open `https://github.com/mem9-ai/mem9/blob/main/server/internal/handler/memory.go` and look at `createMemory`. The shape this plan assumes: `POST /memories` with body `{content: string, tags: string[], metadata: object}` returning `{id: string, ...}`. If the server uses a different envelope (e.g., wraps in `{memory: {...}}`), adjust `Mem9Client` and the tests accordingly — do NOT fork upstream.

**Files:**
- Create: `src/services/mem9/Mem9Client.ts`
- Create: `tests/mem9/Mem9Client.test.ts`

- [ ] **Step 3.1: Write failing tests for store + get**

Create `tests/mem9/Mem9Client.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { Mem9Client } from "../../src/services/mem9/Mem9Client";
import { Mem9Unavailable, Mem9AuthError, Mem9NotFound } from "../../src/services/mem9/errors";

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = impl as any;
  return () => { globalThis.fetch = original; };
}

describe("Mem9Client.store", () => {
  test("POSTs to /memories with content/tags/metadata and returns id", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    const restore = mockFetch(async (url, init) => {
      capturedUrl = url;
      capturedBody = init!.body as string;
      return new Response(JSON.stringify({ id: "mem-abc" }), { status: 200 });
    });
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined });
    const id = await client.store({ content: "hello", tags: ["t1"], metadata: { k: "v" } });
    restore();
    expect(id).toBe("mem-abc");
    expect(capturedUrl).toBe("http://mem9/memories");
    expect(JSON.parse(capturedBody)).toEqual({ content: "hello", tags: ["t1"], metadata: { k: "v" } });
  });

  test("includes Authorization header when apiKey set", async () => {
    let captured: HeadersInit | undefined;
    const restore = mockFetch(async (_, init) => {
      captured = init!.headers;
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    });
    const client = new Mem9Client({ url: "http://mem9", apiKey: "secret" });
    await client.store({ content: "x", tags: [], metadata: {} });
    restore();
    expect((captured as Record<string, string>)["Authorization"]).toBe("Bearer secret");
  });

  test("throws Mem9AuthError on 401", async () => {
    const restore = mockFetch(async () => new Response("", { status: 401 }));
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined });
    restore;
    await expect(client.store({ content: "x", tags: [], metadata: {} })).rejects.toBeInstanceOf(Mem9AuthError);
    restore();
  });

  test("throws Mem9Unavailable on network error", async () => {
    const restore = mockFetch(async () => { throw new TypeError("fetch failed"); });
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined });
    await expect(client.store({ content: "x", tags: [], metadata: {} })).rejects.toBeInstanceOf(Mem9Unavailable);
    restore();
  });
});

describe("Mem9Client.get", () => {
  test("GETs /memories/:id and returns memory", async () => {
    const restore = mockFetch(async (url) => {
      expect(url).toBe("http://mem9/memories/mem-abc");
      return new Response(JSON.stringify({ id: "mem-abc", content: "hi", tags: [], metadata: {} }), { status: 200 });
    });
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined });
    const mem = await client.get("mem-abc");
    restore();
    expect(mem.id).toBe("mem-abc");
    expect(mem.content).toBe("hi");
  });

  test("throws Mem9NotFound on 404", async () => {
    const restore = mockFetch(async () => new Response("", { status: 404 }));
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined });
    await expect(client.get("missing")).rejects.toBeInstanceOf(Mem9NotFound);
    restore();
  });
});
```

- [ ] **Step 3.2: Run to verify failure**

Run: `bun test tests/mem9/Mem9Client.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3.3: Implement store + get**

Create `src/services/mem9/Mem9Client.ts`:

```typescript
import { Mem9Config } from "./config";
import { Mem9Unavailable, Mem9AuthError, Mem9NotFound, Mem9BadRequest } from "./errors";

export interface Mem9Memory {
  id: string;
  content: string;
  tags: string[];
  metadata: Record<string, unknown>;
  source?: string;
  state?: string;
  memory_type?: string;
  agent_id?: string;
  session_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface StoreInput {
  content: string;
  tags: string[];
  metadata: Record<string, unknown>;
  source?: string;
  memory_type?: string;
  agent_id?: string;
  session_id?: string;
}

export class Mem9Client {
  constructor(private readonly cfg: Mem9Config) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.cfg.apiKey) h["Authorization"] = `Bearer ${this.cfg.apiKey}`;
    return h;
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(`${this.cfg.url}${path}`, {
        ...init,
        headers: { ...this.headers(), ...(init?.headers ?? {}) },
      });
    } catch (err) {
      throw new Mem9Unavailable(this.cfg.url, err);
    }
  }

  private async handle(res: Response, context: string): Promise<unknown> {
    if (res.status === 401 || res.status === 403) throw new Mem9AuthError();
    if (res.status === 404) throw new Mem9NotFound(context);
    if (res.status >= 400) {
      const body = await res.text().catch(() => "");
      throw new Mem9BadRequest(`${context} returned ${res.status}`, body);
    }
    return res.json();
  }

  async store(input: StoreInput): Promise<string> {
    const res = await this.request("/memories", {
      method: "POST",
      body: JSON.stringify(input),
    });
    const json = (await this.handle(res, "POST /memories")) as { id: string };
    return json.id;
  }

  async get(id: string): Promise<Mem9Memory> {
    const res = await this.request(`/memories/${encodeURIComponent(id)}`);
    return (await this.handle(res, id)) as Mem9Memory;
  }
}
```

- [ ] **Step 3.4: Run tests**

Run: `bun test tests/mem9/Mem9Client.test.ts`
Expected: 6 pass.

- [ ] **Step 3.5: Commit**

```bash
git add src/services/mem9/Mem9Client.ts tests/mem9/Mem9Client.test.ts
git commit -m "feat(mem9): add Mem9Client store + get"
```

---

## Task 4: Mem9Client — update, delete, search

**Files:**
- Modify: `src/services/mem9/Mem9Client.ts`
- Modify: `tests/mem9/Mem9Client.test.ts`

- [ ] **Step 4.1: Add failing tests for update/delete/search**

Append to `tests/mem9/Mem9Client.test.ts`:

```typescript
describe("Mem9Client.update", () => {
  test("PUTs /memories/:id with patch body", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    const restore = mockFetch(async (url, init) => {
      capturedUrl = url;
      capturedBody = init!.body as string;
      return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
    });
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined });
    await client.update("m1", { metadata: { status: "done" } });
    restore();
    expect(capturedUrl).toBe("http://mem9/memories/m1");
    expect(JSON.parse(capturedBody)).toEqual({ metadata: { status: "done" } });
  });
});

describe("Mem9Client.delete", () => {
  test("DELETEs /memories/:id", async () => {
    let capturedMethod = "";
    const restore = mockFetch(async (_, init) => {
      capturedMethod = init!.method!;
      return new Response("", { status: 204 });
    });
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined });
    await client.delete("m1");
    restore();
    expect(capturedMethod).toBe("DELETE");
  });
});

describe("Mem9Client.search", () => {
  test("builds GET /memories with query params and returns results", async () => {
    let capturedUrl = "";
    const restore = mockFetch(async (url) => {
      capturedUrl = url;
      return new Response(JSON.stringify({
        results: [{ id: "m1", content: "x", tags: [], metadata: {} }],
      }), { status: 200 });
    });
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined });
    const out = await client.search({
      query: "hello",
      tags: ["kind:observation", "project:demo"],
      limit: 10,
    });
    restore();
    expect(out.length).toBe(1);
    expect(capturedUrl).toContain("query=hello");
    expect(capturedUrl).toContain("tags=kind%3Aobservation%2Cproject%3Ademo");
    expect(capturedUrl).toContain("limit=10");
  });
});
```

- [ ] **Step 4.2: Run — expect new tests to fail**

Run: `bun test tests/mem9/Mem9Client.test.ts`
Expected: 6 pass, 3 fail.

- [ ] **Step 4.3: Extend `Mem9Client.ts`**

Append these methods and the `SearchInput` interface to `src/services/mem9/Mem9Client.ts`:

```typescript
export interface SearchInput {
  query?: string;
  tags?: string[];
  source?: string;
  state?: string;
  memoryType?: string;
  agentId?: string;
  sessionId?: string;
  limit?: number;
  offset?: number;
  minScore?: number;
}

// Inside class Mem9Client, add:

async update(id: string, patch: Partial<StoreInput>): Promise<void> {
  const res = await this.request(`/memories/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
  await this.handle(res, `PUT ${id}`);
}

async delete(id: string): Promise<void> {
  const res = await this.request(`/memories/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.status === 204) return;
  await this.handle(res, `DELETE ${id}`);
}

async search(input: SearchInput): Promise<Mem9Memory[]> {
  const params = new URLSearchParams();
  if (input.query) params.set("query", input.query);
  if (input.tags?.length) params.set("tags", input.tags.join(","));
  if (input.source) params.set("source", input.source);
  if (input.state) params.set("state", input.state);
  if (input.memoryType) params.set("memory_type", input.memoryType);
  if (input.agentId) params.set("agent_id", input.agentId);
  if (input.sessionId) params.set("session_id", input.sessionId);
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  if (input.offset !== undefined) params.set("offset", String(input.offset));
  if (input.minScore !== undefined) params.set("min_score", String(input.minScore));
  const res = await this.request(`/memories?${params.toString()}`);
  const json = (await this.handle(res, "GET /memories")) as { results: Mem9Memory[] };
  return json.results ?? [];
}
```

- [ ] **Step 4.4: Run all client tests**

Run: `bun test tests/mem9/Mem9Client.test.ts`
Expected: 9 pass.

- [ ] **Step 4.5: Commit**

```bash
git add src/services/mem9/Mem9Client.ts tests/mem9/Mem9Client.test.ts
git commit -m "feat(mem9): add Mem9Client update/delete/search"
```

---

## Task 5: mapping.ts — observation entity ↔ memories

**Why split mapping across two tasks:** observation has the most complex shape (1 parent + N field memories). Other entities are 1:1.

**Files:**
- Create: `src/services/mem9/mapping.ts`
- Create: `tests/mem9/mapping.test.ts`

- [ ] **Step 5.1: Write failing round-trip test**

Create `tests/mem9/mapping.test.ts`:

```typescript
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
```

- [ ] **Step 5.2: Run — expect failure**

Run: `bun test tests/mem9/mapping.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 5.3: Implement observation mapping**

Create `src/services/mem9/mapping.ts`:

```typescript
import type { StoreInput, Mem9Memory } from "./Mem9Client";

export const FIELD_MEMORY_KINDS = ["field_narrative", "field_fact", "field_concept"] as const;

export interface ObservationEntity {
  id: string;
  memory_session_id: string | null;
  project: string;
  type: string;
  title: string;
  subtitle: string;
  narrative: string;
  facts: string[];
  concepts: string[];
  files_read: string[];
  files_modified: string[];
  created_at_epoch: number;
  prompt_number: number | null;
  discovery_tokens: number | null;
  content_hash: string | null;
  merged_into_project: string | null;
  agent_type: string | null;
  agent_id: string | null;
}

export interface ObservationMemories {
  parent: StoreInput;
  fields: StoreInput[];
}

function baseTags(obs: ObservationEntity): string[] {
  const tags: string[] = ["kind:observation", `project:${obs.project}`];
  if (obs.merged_into_project) tags.push(`merged_into:${obs.merged_into_project}`);
  return tags;
}

export function observationToMemories(obs: ObservationEntity): ObservationMemories {
  const parent: StoreInput = {
    content: `${obs.title}\n\n${obs.subtitle}\n\n${obs.narrative}`,
    tags: baseTags(obs),
    memory_type: "observation",
    source: obs.project,
    session_id: obs.memory_session_id ?? undefined,
    agent_id: obs.agent_id ?? undefined,
    metadata: {
      kind: "observation",
      title: obs.title,
      subtitle: obs.subtitle,
      narrative: obs.narrative,
      facts: obs.facts,
      concepts: obs.concepts,
      files_read: obs.files_read,
      files_modified: obs.files_modified,
      observation_type: obs.type,
      agent_type: obs.agent_type,
      prompt_number: obs.prompt_number,
      discovery_tokens: obs.discovery_tokens,
      content_hash: obs.content_hash,
      created_at_epoch: obs.created_at_epoch,
      merged_into_project: obs.merged_into_project,
    },
  };

  const fields: StoreInput[] = [];
  const parentMarker = `parent:${obs.id}`;
  const fieldCommon = {
    source: obs.project,
    session_id: obs.memory_session_id ?? undefined,
  };

  fields.push({
    ...fieldCommon,
    content: obs.narrative,
    tags: [...baseTags(obs), parentMarker, "field:narrative"],
    memory_type: "observation_field",
    metadata: { kind: "field_narrative", parent_id: obs.id, created_at_epoch: obs.created_at_epoch },
  });
  for (const fact of obs.facts) {
    fields.push({
      ...fieldCommon,
      content: fact,
      tags: [...baseTags(obs), parentMarker, "field:fact"],
      memory_type: "observation_field",
      metadata: { kind: "field_fact", parent_id: obs.id, created_at_epoch: obs.created_at_epoch },
    });
  }
  for (const concept of obs.concepts) {
    fields.push({
      ...fieldCommon,
      content: concept,
      tags: [...baseTags(obs), parentMarker, "field:concept"],
      memory_type: "observation_field",
      metadata: { kind: "field_concept", parent_id: obs.id, created_at_epoch: obs.created_at_epoch },
    });
  }
  return { parent, fields };
}

export function memoriesToObservation(parent: Mem9Memory, fields: Mem9Memory[]): ObservationEntity {
  const m = parent.metadata as Record<string, unknown>;
  return {
    id: parent.id,
    memory_session_id: (parent.session_id as string) ?? null,
    project: (parent.source as string) ?? "",
    type: (m.observation_type as string) ?? "",
    title: (m.title as string) ?? "",
    subtitle: (m.subtitle as string) ?? "",
    narrative: (m.narrative as string) ?? "",
    facts: (m.facts as string[]) ?? [],
    concepts: (m.concepts as string[]) ?? [],
    files_read: (m.files_read as string[]) ?? [],
    files_modified: (m.files_modified as string[]) ?? [],
    created_at_epoch: (m.created_at_epoch as number) ?? 0,
    prompt_number: (m.prompt_number as number) ?? null,
    discovery_tokens: (m.discovery_tokens as number) ?? null,
    content_hash: (m.content_hash as string) ?? null,
    merged_into_project: (m.merged_into_project as string) ?? null,
    agent_type: (m.agent_type as string) ?? null,
    agent_id: (parent.agent_id as string) ?? null,
  };
}
```

- [ ] **Step 5.4: Run — expect pass**

Run: `bun test tests/mem9/mapping.test.ts`
Expected: 3 pass.

- [ ] **Step 5.5: Commit**

```bash
git add src/services/mem9/mapping.ts tests/mem9/mapping.test.ts
git commit -m "feat(mem9): observation ↔ memories mapping with parent+field split"
```

---

## Task 6: mapping.ts — summary, prompt, session, feedback, pending_message

**Files:**
- Modify: `src/services/mem9/mapping.ts`
- Modify: `tests/mem9/mapping.test.ts`

- [ ] **Step 6.1: Add failing tests for other kinds**

Append to `tests/mem9/mapping.test.ts`:

```typescript
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
```

- [ ] **Step 6.2: Run — expect failure**

Run: `bun test tests/mem9/mapping.test.ts`
Expected: new tests fail (undefined exports).

- [ ] **Step 6.3: Append to `src/services/mem9/mapping.ts`**

```typescript
// ---- summary ----
export interface SummaryEntity {
  id: string;
  memory_session_id: string;
  project: string;
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  files_read: string[];
  files_edited: string[];
  notes: string;
  created_at_epoch: number;
  prompt_number: number | null;
  discovery_tokens: number | null;
  merged_into_project: string | null;
}

export function summaryToMemory(s: SummaryEntity): StoreInput {
  return {
    content: [s.request, s.investigated, s.learned, s.completed, s.next_steps, s.notes].filter(Boolean).join("\n\n"),
    tags: ["kind:summary", `project:${s.project}`],
    memory_type: "summary",
    source: s.project,
    session_id: s.memory_session_id,
    metadata: {
      kind: "summary",
      request: s.request,
      investigated: s.investigated,
      learned: s.learned,
      completed: s.completed,
      next_steps: s.next_steps,
      files_read: s.files_read,
      files_edited: s.files_edited,
      notes: s.notes,
      created_at_epoch: s.created_at_epoch,
      prompt_number: s.prompt_number,
      discovery_tokens: s.discovery_tokens,
      merged_into_project: s.merged_into_project,
    },
  };
}

export function memoryToSummary(mem: Mem9Memory): SummaryEntity {
  const m = mem.metadata as Record<string, unknown>;
  return {
    id: mem.id,
    memory_session_id: (mem.session_id as string) ?? "",
    project: (mem.source as string) ?? "",
    request: (m.request as string) ?? "",
    investigated: (m.investigated as string) ?? "",
    learned: (m.learned as string) ?? "",
    completed: (m.completed as string) ?? "",
    next_steps: (m.next_steps as string) ?? "",
    files_read: (m.files_read as string[]) ?? [],
    files_edited: (m.files_edited as string[]) ?? [],
    notes: (m.notes as string) ?? "",
    created_at_epoch: (m.created_at_epoch as number) ?? 0,
    prompt_number: (m.prompt_number as number) ?? null,
    discovery_tokens: (m.discovery_tokens as number) ?? null,
    merged_into_project: (m.merged_into_project as string) ?? null,
  };
}

// ---- user_prompt ----
export interface PromptEntity {
  id: string;
  content_session_id: string;
  prompt_text: string;
  prompt_number: number;
  created_at_epoch: number;
}

export function promptToMemory(p: PromptEntity): StoreInput {
  return {
    content: p.prompt_text,
    tags: ["kind:user_prompt"],
    memory_type: "user_prompt",
    session_id: p.content_session_id,
    metadata: {
      kind: "user_prompt",
      content_session_id: p.content_session_id,
      prompt_number: p.prompt_number,
      created_at_epoch: p.created_at_epoch,
    },
  };
}

export function memoryToPrompt(mem: Mem9Memory): PromptEntity {
  const m = mem.metadata as Record<string, unknown>;
  return {
    id: mem.id,
    content_session_id: (m.content_session_id as string) ?? "",
    prompt_text: mem.content,
    prompt_number: (m.prompt_number as number) ?? 0,
    created_at_epoch: (m.created_at_epoch as number) ?? 0,
  };
}

// ---- session ----
export interface SessionEntity {
  id: string;
  content_session_id: string;
  memory_session_id: string;
  project: string;
  status: string;
  platform_source: string;
  started_at_epoch: number;
  completed_at_epoch: number | null;
  worker_port: number;
  prompt_counter: number;
}

export function sessionToMemory(s: SessionEntity): StoreInput {
  return {
    content: `session ${s.id} (${s.status})`,
    tags: ["kind:session", `project:${s.project}`, `status:${s.status}`],
    memory_type: "session",
    source: s.project,
    session_id: s.memory_session_id,
    metadata: {
      kind: "session",
      content_session_id: s.content_session_id,
      platform_source: s.platform_source,
      status: s.status,
      started_at_epoch: s.started_at_epoch,
      completed_at_epoch: s.completed_at_epoch,
      worker_port: s.worker_port,
      prompt_counter: s.prompt_counter,
    },
  };
}

export function memoryToSession(mem: Mem9Memory): SessionEntity {
  const m = mem.metadata as Record<string, unknown>;
  return {
    id: mem.id,
    content_session_id: (m.content_session_id as string) ?? "",
    memory_session_id: (mem.session_id as string) ?? "",
    project: (mem.source as string) ?? "",
    status: (m.status as string) ?? "",
    platform_source: (m.platform_source as string) ?? "",
    started_at_epoch: (m.started_at_epoch as number) ?? 0,
    completed_at_epoch: (m.completed_at_epoch as number) ?? null,
    worker_port: (m.worker_port as number) ?? 0,
    prompt_counter: (m.prompt_counter as number) ?? 0,
  };
}

// ---- feedback ----
export interface FeedbackEntity {
  observation_id: string;
  rating: number;
  tags: string[];
}

export function feedbackToMemory(f: FeedbackEntity): StoreInput {
  return {
    content: `feedback on ${f.observation_id}: ${f.rating}`,
    tags: ["kind:feedback", `target:${f.observation_id}`],
    memory_type: "feedback",
    metadata: {
      kind: "feedback",
      target_observation_id: f.observation_id,
      rating: f.rating,
      feedback_tags: f.tags,
    },
  };
}

export function memoryToFeedback(mem: Mem9Memory): FeedbackEntity & { id: string } {
  const m = mem.metadata as Record<string, unknown>;
  return {
    id: mem.id,
    observation_id: (m.target_observation_id as string) ?? "",
    rating: (m.rating as number) ?? 0,
    tags: (m.feedback_tags as string[]) ?? [],
  };
}

// ---- pending_message ----
export interface PendingMessageEntity {
  session_id: string;
  pending_count: number;
  last_check_epoch: number;
}

export function pendingMessageToMemory(p: PendingMessageEntity): StoreInput {
  return {
    content: `pending:${p.session_id}:${p.pending_count}`,
    tags: ["kind:pending_message"],
    memory_type: "pending_message",
    session_id: p.session_id,
    metadata: {
      kind: "pending_message",
      pending_count: p.pending_count,
      last_check_epoch: p.last_check_epoch,
    },
  };
}

export function memoryToPendingMessage(mem: Mem9Memory): PendingMessageEntity {
  const m = mem.metadata as Record<string, unknown>;
  return {
    session_id: (mem.session_id as string) ?? "",
    pending_count: (m.pending_count as number) ?? 0,
    last_check_epoch: (m.last_check_epoch as number) ?? 0,
  };
}
```

- [ ] **Step 6.4: Run — expect pass**

Run: `bun test tests/mem9/mapping.test.ts`
Expected: 8 pass.

- [ ] **Step 6.5: Commit**

```bash
git add src/services/mem9/mapping.ts tests/mem9/mapping.test.ts
git commit -m "feat(mem9): mapping for summary/prompt/session/feedback/pending_message"
```

---

## Task 7: Healthcheck

**Why:** used at worker boot to fail-fast before SQLite fallback races with mem9 init. Also used by migration CLI as a preflight.

**Files:**
- Create: `src/services/mem9/healthcheck.ts`
- Create: `tests/mem9/healthcheck.test.ts`

- [ ] **Step 7.1: Write failing test**

```typescript
import { describe, test, expect } from "bun:test";
import { healthcheckMem9 } from "../../src/services/mem9/healthcheck";
import { Mem9Client } from "../../src/services/mem9/Mem9Client";
import { Mem9Unavailable } from "../../src/services/mem9/errors";

function fakeClient(impl: Partial<Mem9Client>): Mem9Client {
  return impl as Mem9Client;
}

describe("healthcheckMem9", () => {
  test("returns true when search succeeds", async () => {
    const client = fakeClient({ search: async () => [] });
    expect(await healthcheckMem9(client)).toBe(true);
  });

  test("rethrows Mem9Unavailable so caller can fail fast", async () => {
    const client = fakeClient({
      search: async () => { throw new Mem9Unavailable("http://mem9"); },
    });
    await expect(healthcheckMem9(client)).rejects.toBeInstanceOf(Mem9Unavailable);
  });
});
```

- [ ] **Step 7.2: Run — expect failure**

Run: `bun test tests/mem9/healthcheck.test.ts`
Expected: FAIL.

- [ ] **Step 7.3: Implement**

Create `src/services/mem9/healthcheck.ts`:

```typescript
import { Mem9Client } from "./Mem9Client";

export async function healthcheckMem9(client: Mem9Client): Promise<boolean> {
  // minimal probe: a search with limit=1 hits the server without requiring known data
  await client.search({ limit: 1 });
  return true;
}
```

- [ ] **Step 7.4: Run — expect pass**

Run: `bun test tests/mem9/healthcheck.test.ts`
Expected: 2 pass.

- [ ] **Step 7.5: Commit**

```bash
git add src/services/mem9/healthcheck.ts tests/mem9/healthcheck.test.ts
git commit -m "feat(mem9): add healthcheck probe"
```

---

## Task 8: Mem9Store with Promise.all fan-out + rollback

**Why this shape:** isolates the N+1 write pattern and atomicity logic. Anyone wanting to swap the atomicity strategy (e.g., add retry) changes one file.

**Files:**
- Create: `src/services/mem9/Mem9Store.ts`
- Create: `tests/mem9/Mem9Store.test.ts`

- [ ] **Step 8.1: Write failing tests**

```typescript
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
```

- [ ] **Step 8.2: Run — expect failure**

Run: `bun test tests/mem9/Mem9Store.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 8.3: Implement**

Create `src/services/mem9/Mem9Store.ts`:

```typescript
import { Mem9Client } from "./Mem9Client";
import {
  observationToMemories, summaryToMemory, promptToMemory,
  sessionToMemory, feedbackToMemory, pendingMessageToMemory,
  type ObservationEntity, type SummaryEntity, type PromptEntity,
  type SessionEntity, type FeedbackEntity, type PendingMessageEntity,
} from "./mapping";

export class Mem9Store {
  constructor(private readonly client: Mem9Client) {}

  async storeObservation(obs: ObservationEntity): Promise<string> {
    const { parent, fields } = observationToMemories(obs);
    const parentId = await this.client.store(parent);
    try {
      // rewrite field parent tags with the actual returned id
      const fieldsWithParent = fields.map((f) => ({
        ...f,
        tags: f.tags.map((t) => t.startsWith("parent:") ? `parent:${parentId}` : t),
        metadata: { ...f.metadata, parent_id: parentId },
      }));
      await Promise.all(fieldsWithParent.map((f) => this.client.store(f)));
      return parentId;
    } catch (err) {
      // rollback parent
      await this.client.delete(parentId).catch(() => {});
      throw err;
    }
  }

  async storeSummary(s: SummaryEntity): Promise<string> {
    return this.client.store(summaryToMemory(s));
  }

  async storePrompt(p: PromptEntity): Promise<string> {
    return this.client.store(promptToMemory(p));
  }

  async storeSession(s: SessionEntity): Promise<string> {
    return this.client.store(sessionToMemory(s));
  }

  async updateSession(id: string, patch: Partial<SessionEntity>): Promise<void> {
    // translate partial entity → metadata patch
    const metadata: Record<string, unknown> = {};
    if (patch.status !== undefined) metadata.status = patch.status;
    if (patch.completed_at_epoch !== undefined) metadata.completed_at_epoch = patch.completed_at_epoch;
    if (patch.prompt_counter !== undefined) metadata.prompt_counter = patch.prompt_counter;
    await this.client.update(id, { metadata });
  }

  async storeFeedback(f: FeedbackEntity): Promise<string> {
    return this.client.store(feedbackToMemory(f));
  }

  async storePendingMessage(p: PendingMessageEntity): Promise<string> {
    return this.client.store(pendingMessageToMemory(p));
  }
}
```

- [ ] **Step 8.4: Run — expect pass**

Run: `bun test tests/mem9/Mem9Store.test.ts`
Expected: 2 pass.

- [ ] **Step 8.5: Commit**

```bash
git add src/services/mem9/Mem9Store.ts tests/mem9/Mem9Store.test.ts
git commit -m "feat(mem9): add Mem9Store with rollback on field-store failure"
```

---

## Task 9: Mem9Search with two-pass over-fetch + post-filter

**Why two-pass:** mem9 filter surface is flat. Rich predicates (time windows, `merged_into_project`) must be applied client-side after fetch.

**Files:**
- Create: `src/services/mem9/Mem9Search.ts`
- Create: `tests/mem9/Mem9Search.test.ts`

- [ ] **Step 9.1: Write failing test**

```typescript
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
```

- [ ] **Step 9.2: Run — expect failure**

Run: `bun test tests/mem9/Mem9Search.test.ts`
Expected: FAIL.

- [ ] **Step 9.3: Implement**

Create `src/services/mem9/Mem9Search.ts`:

```typescript
import { Mem9Client, Mem9Memory } from "./Mem9Client";
import { memoriesToObservation, type ObservationEntity } from "./mapping";

export interface SearchObservationsInput {
  query?: string;
  project?: string;
  sessionId?: string;
  agentId?: string;
  createdAfter?: number;
  createdBefore?: number;
  limit?: number;
  overfetchMultiplier?: number;
}

export class Mem9Search {
  constructor(private readonly client: Mem9Client) {}

  async searchObservations(input: SearchObservationsInput): Promise<ObservationEntity[]> {
    const limit = input.limit ?? 20;
    const overfetch = (input.overfetchMultiplier ?? 3) * limit;
    const tags: string[] = ["kind:observation"];
    if (input.project) tags.push(`project:${input.project}`);

    const raw = await this.client.search({
      query: input.query,
      tags,
      sessionId: input.sessionId,
      agentId: input.agentId,
      limit: overfetch,
    });

    // dedupe by parent_id (field memories collapse into parents)
    const seen = new Set<string>();
    const parents: Mem9Memory[] = [];
    const parentIdsFromFields: Set<string> = new Set();
    for (const m of raw) {
      const kind = (m.metadata as Record<string, unknown>).kind as string;
      if (kind === "observation") {
        if (!seen.has(m.id)) { seen.add(m.id); parents.push(m); }
      } else if (kind && kind.startsWith("field_")) {
        const pid = (m.metadata as Record<string, unknown>).parent_id as string | undefined;
        if (pid && !seen.has(pid)) parentIdsFromFields.add(pid);
      }
    }

    // fetch any parents that only appeared via their field memories
    const fetched = await Promise.all(
      Array.from(parentIdsFromFields).map((id) => this.client.get(id).catch(() => null))
    );
    for (const p of fetched) if (p && !seen.has(p.id)) { seen.add(p.id); parents.push(p); }

    // client-side post-filter
    let result = parents.map((p) => memoriesToObservation(p, []));
    if (input.createdAfter !== undefined) {
      result = result.filter((o) => o.created_at_epoch >= input.createdAfter!);
    }
    if (input.createdBefore !== undefined) {
      result = result.filter((o) => o.created_at_epoch <= input.createdBefore!);
    }
    return result.slice(0, limit);
  }
}
```

- [ ] **Step 9.4: Run — expect pass**

Run: `bun test tests/mem9/Mem9Search.test.ts`
Expected: 2 pass.

- [ ] **Step 9.5: Commit**

```bash
git add src/services/mem9/Mem9Search.ts tests/mem9/Mem9Search.test.ts
git commit -m "feat(mem9): add Mem9Search with two-pass over-fetch + post-filter"
```

---

## Task 10: Mem9Manager + DatabaseManager wiring (feature-flag entry point)

**Why:** single place that decides "is mem9 active this boot?" All other code asks the manager; no one reads `MEM9_URL` directly.

**Files:**
- Create: `src/services/mem9/Mem9Manager.ts`
- Modify: `src/services/DatabaseManager.ts` (additive only — add a getter, do not change existing behavior)

- [ ] **Step 10.1: Implement `Mem9Manager.ts`**

```typescript
import { Mem9Client } from "./Mem9Client";
import { Mem9Store } from "./Mem9Store";
import { Mem9Search } from "./Mem9Search";
import { loadMem9Config, isMem9Enabled, type Mem9Config } from "./config";
import { healthcheckMem9 } from "./healthcheck";

export class Mem9Manager {
  readonly client: Mem9Client;
  readonly store: Mem9Store;
  readonly search: Mem9Search;
  readonly config: Mem9Config;

  constructor(cfg?: Mem9Config) {
    this.config = cfg ?? loadMem9Config();
    this.client = new Mem9Client(this.config);
    this.store = new Mem9Store(this.client);
    this.search = new Mem9Search(this.client);
  }

  async healthcheck(): Promise<boolean> {
    return healthcheckMem9(this.client);
  }

  static isEnabled(): boolean {
    return isMem9Enabled();
  }
}
```

- [ ] **Step 10.2: Read current `DatabaseManager.ts` to find a safe insertion point**

Run: `bun --print "require('fs').readFileSync('src/services/DatabaseManager.ts','utf8').length"` — just to be aware. Then open the file and:

- Add `import { Mem9Manager } from "./mem9/Mem9Manager";` at the top.
- Add a private field: `private mem9Manager: Mem9Manager | null = null;`
- Add an initializer inside the existing constructor / init method (wherever SQLite init already lives):

```typescript
if (Mem9Manager.isEnabled()) {
  this.mem9Manager = new Mem9Manager();
}
```

- Add a public getter:

```typescript
getMem9Manager(): Mem9Manager | null {
  return this.mem9Manager;
}
```

Do NOT remove or reorder any existing SQLite/Chroma initialization. The field is additive.

- [ ] **Step 10.3: Smoke-test with existing tests**

Run: `bun test tests/sqlite/ tests/worker/`
Expected: all pre-existing tests still pass. If any fail, revert the `DatabaseManager` edits — you've broken a contract that needs a more targeted touch.

- [ ] **Step 10.4: Commit**

```bash
git add src/services/mem9/Mem9Manager.ts src/services/DatabaseManager.ts
git commit -m "feat(mem9): add Mem9Manager + DatabaseManager getter (no behavior change)"
```

---

## Task 11: Feature-flag branch in ResponseProcessor (write path)

**Files:**
- Modify: `src/services/worker/agents/ResponseProcessor.ts`

- [ ] **Step 11.1: Locate the observation/summary write calls**

Open `src/services/worker/agents/ResponseProcessor.ts`. Find the existing calls to `storeObservation` / `storeSummary` (the SQLite path) and the subsequent `chromaSync?.syncObservation` / `chromaSync?.syncSummary` calls. These are typically clustered near lines 60-160 based on the survey.

- [ ] **Step 11.2: Add branch**

At the top of the file, add:

```typescript
import type { Mem9Manager } from "../../mem9/Mem9Manager";
```

Replace each existing storage block:

```typescript
// BEFORE
sessionStore.storeObservation(obs);
chromaSync?.syncObservation(obs).catch(...);

// AFTER
const mem9 = dbManager.getMem9Manager();
if (mem9) {
  await mem9.store.storeObservation(obs);
} else {
  sessionStore.storeObservation(obs);
  chromaSync?.syncObservation(obs).catch(...);
}
```

Apply the same pattern to `storeSummary`. Do **not** touch any other logic.

- [ ] **Step 11.3: Run existing tests**

Run: `bun test tests/worker/`
Expected: all pre-existing tests still pass (MEM9_URL unset during tests → legacy path executes).

- [ ] **Step 11.4: Commit**

```bash
git add src/services/worker/agents/ResponseProcessor.ts
git commit -m "feat(mem9): ResponseProcessor branches to mem9 when MEM9_URL set"
```

---

## Task 11b: Feature-flag branch in SessionManager (session lifecycle writes)

**Why:** sessions are written outside `ResponseProcessor` (in `src/services/worker/SessionManager.ts`) on start/end/prompt-count-increment. We need the same branch pattern there so the session record lives in mem9 when enabled.

**Files:**
- Modify: `src/services/worker/SessionManager.ts`

- [ ] **Step 11b.1: Locate session write calls**

Open `src/services/worker/SessionManager.ts`. Identify where `sessionStore.storeSession` / `sessionStore.updateSession` (or equivalent SQLite calls) are invoked. There should be three sites: session creation, session completion, and prompt-counter increment.

- [ ] **Step 11b.2: Add branch at each site**

For each site, add the pattern (example for session creation):

```typescript
const mem9 = this.dbManager.getMem9Manager();
if (mem9) {
  await mem9.store.storeSession(sessionEntity);
} else {
  sessionStore.storeSession(sessionEntity);
}
```

For updates (session completion, prompt-counter):

```typescript
const mem9 = this.dbManager.getMem9Manager();
if (mem9) {
  await mem9.store.updateSession(sessionId, { status: "completed", completed_at_epoch });
} else {
  sessionStore.updateSession(sessionId, { status: "completed", completed_at_epoch });
}
```

Adjust field names to match the actual `SessionManager` call-site shapes — these are the patterns, not literal transcriptions.

- [ ] **Step 11b.3: Run existing session tests**

Run: `bun test tests/worker/`
Expected: all pass with MEM9_URL unset.

- [ ] **Step 11b.4: Commit**

```bash
git add src/services/worker/SessionManager.ts
git commit -m "feat(mem9): SessionManager branches to mem9 when MEM9_URL set"
```

---

## Task 12: Feature-flag branch in SearchManager (read path)

**Files:**
- Modify: `src/services/worker/SearchManager.ts`

- [ ] **Step 12.1: Add branch**

Open `src/services/worker/SearchManager.ts`. The main `search()` method currently fans out to `SessionSearch` + `ChromaSync.queryChroma` + hybrid strategies. Add, at the top of `search()`:

```typescript
const mem9 = this.dbManager.getMem9Manager();
if (mem9) {
  const obs = await mem9.search.searchObservations({
    query: input.query,
    project: input.project,
    sessionId: input.sessionId,
    limit: input.limit,
    createdAfter: input.createdAfter,
    createdBefore: input.createdBefore,
  });
  return this.formatSearchResponse(obs); // reuse existing formatter; adjust to accept ObservationEntity[]
}
// else — fall through to existing SQLite+Chroma logic (unchanged)
```

If `formatSearchResponse` doesn't exist or takes a different shape, extract the tail of the existing `search()` into a helper and call it from both branches. Keep the PR surgical.

- [ ] **Step 12.2: Run existing search tests**

Run: `bun test tests/worker/search/`
Expected: all tests still pass (MEM9_URL unset → legacy path).

- [ ] **Step 12.3: Commit**

```bash
git add src/services/worker/SearchManager.ts
git commit -m "feat(mem9): SearchManager branches to mem9 when MEM9_URL set"
```

---

## Task 13: Boot-time healthcheck wiring

**Why:** if `MEM9_URL` is set but the server is unreachable, we want a clear error at worker start, not cryptic failures on the first observation write. Phase 1 rule: unreachable mem9 with `MEM9_URL` set is a fatal error — we do NOT silently fall back to legacy.

**Files:**
- Modify: `src/services/worker-service.ts`

- [ ] **Step 13.1: Wire healthcheck at boot**

Open `src/services/worker-service.ts`. Find the section where `DatabaseManager` is constructed and SQLite init runs. After that, before the Express listen call, add:

```typescript
import { Mem9Manager } from "./mem9/Mem9Manager";

if (Mem9Manager.isEnabled()) {
  const mgr = dbManager.getMem9Manager();
  if (mgr) {
    try {
      await mgr.healthcheck();
      logger.info(`mem9 healthy at ${mgr.config.url}`);
    } catch (err) {
      logger.error(`mem9 healthcheck failed: ${err}`);
      process.exit(1);
    }
  }
}
```

- [ ] **Step 13.2: Smoke test**

Manual check (document result in the commit message if anything unexpected):
1. Start worker with no `MEM9_URL` → should boot exactly as before (`npm run worker:restart`, check `npm run worker:status`).
2. Start worker with `MEM9_URL=http://localhost:9999` (nothing listening) → should exit with the error message and log the healthcheck failure.
3. Start worker with `MEM9_URL=<real mem9 server>` → should log `mem9 healthy`.

- [ ] **Step 13.3: Commit**

```bash
git add src/services/worker-service.ts
git commit -m "feat(mem9): boot-time healthcheck fails fast when MEM9_URL unreachable"
```

---

## Task 14: Integration tests (write/read roundtrip)

**Files:**
- Create: `tests/mem9/integration/write-read-roundtrip.test.ts`

- [ ] **Step 14.1: Write test (skips when MEM9_URL unset)**

```typescript
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
```

- [ ] **Step 14.2: Run without MEM9_URL**

Run: `bun test tests/mem9/integration/`
Expected: test is skipped.

- [ ] **Step 14.3: Run with a live mem9 server (manual)**

Set `MEM9_URL=http://localhost:8080` pointing at a real mem9 instance.
Run: `MEM9_URL=http://localhost:8080 bun test tests/mem9/integration/`
Expected: test passes. If it fails, the most common cause is the POST /memories payload envelope — check Task 3's verification note.

- [ ] **Step 14.4: Add session lifecycle integration test**

Create `tests/mem9/integration/session-lifecycle.test.ts`:

```typescript
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

    // verify via search
    const results = await mgr.search.searchObservations({
      project: "mem9-it", sessionId: `m-it-${started}`, limit: 5,
    });
    // session itself is kind:session, not kind:observation, so searchObservations filters it out —
    // verify via direct client get instead
    const mem = await mgr.client.get(id);
    expect((mem.metadata as any).status).toBe("completed");
    expect((mem.metadata as any).prompt_counter).toBe(5);
  });
});
```

- [ ] **Step 14.5: Commit**

```bash
git add tests/mem9/integration/
git commit -m "test(mem9): integration roundtrip + session lifecycle tests"
```

---

## Task 15: Migration CLI

**Files:**
- Create: `src/cli/migrate-to-mem9-command.ts`
- Create: `tests/mem9/integration/migration.test.ts`

- [ ] **Step 15.1: Implement CLI**

```typescript
import { DatabaseManager } from "../services/DatabaseManager";
import { Mem9Manager } from "../services/mem9/Mem9Manager";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export async function runMigrateToMem9(): Promise<void> {
  if (!Mem9Manager.isEnabled()) {
    console.error("MEM9_URL is not set. Set MEM9_URL before running migrate-to-mem9.");
    process.exit(1);
  }
  const mem9 = new Mem9Manager();
  await mem9.healthcheck();
  console.log(`mem9 healthy at ${mem9.config.url}. Starting migration…`);

  const db = new DatabaseManager();
  // Use the existing read-only accessors on DatabaseManager. Replace the getters below
  // with the ones that match the project's actual API (e.g. db.getSessionStore().listObservations()).
  const sessionStore = (db as any).getSessionStore?.();
  const sessionSearch = (db as any).getSessionSearch?.();
  if (!sessionStore || !sessionSearch) {
    console.error("DatabaseManager does not expose sessionStore/sessionSearch; update migrate-to-mem9 to match the actual API.");
    process.exit(1);
  }

  const observations = sessionSearch.listAllObservations?.() ?? [];
  const summaries = sessionSearch.listAllSummaries?.() ?? [];
  const prompts = sessionSearch.listAllPrompts?.() ?? [];
  const sessions = sessionSearch.listAllSessions?.() ?? [];

  let n = 0;
  for (const obs of observations) { await mem9.store.storeObservation(obs); n++; }
  console.log(`observations: ${n}`);
  n = 0;
  for (const s of summaries) { await mem9.store.storeSummary(s); n++; }
  console.log(`summaries: ${n}`);
  n = 0;
  for (const p of prompts) { await mem9.store.storePrompt(p); n++; }
  console.log(`prompts: ${n}`);
  n = 0;
  for (const s of sessions) { await mem9.store.storeSession(s); n++; }
  console.log(`sessions: ${n}`);

  const marker = join(homedir(), ".claude-mem", ".migrated-to-mem9");
  writeFileSync(marker, `migrated_at=${new Date().toISOString()}\nmem9_url=${mem9.config.url}\n`);
  console.log(`Migration complete. Marker written to ${marker}.`);
  console.log("Original SQLite DB preserved — delete manually once you trust the migration.");
}
```

**Note on list methods:** the `listAll*` methods may not exist on today's `SessionSearch` — before wiring them in, open `src/services/sqlite/SessionSearch.ts` and either (a) use an existing enumeration method or (b) add read-only `listAll*` wrappers as part of this task. Do NOT invent method names.

- [ ] **Step 15.2: Register CLI in the binary entrypoint**

Find the existing command dispatch file — look for files that import other `*-command.ts` modules from `src/cli/`:

```bash
grep -rn "from.*cli/.*-command" src/cli/ src/npx-cli/ 2>/dev/null | head
```

This will point to the dispatcher (e.g., `src/npx-cli/index.ts` or `src/cli/index.ts`). Open it and:

1. Add an import: `import { runMigrateToMem9 } from "./migrate-to-mem9-command";` (adjust path if the dispatcher is outside `src/cli/`).
2. In the command switch/dispatch block, add a case for `migrate-to-mem9` that calls `await runMigrateToMem9()`.

Do not alter the dispatch pattern — follow what existing commands in the same file use (subcommand name, async invocation, exit code handling).

- [ ] **Step 15.2b: Add migration integration test**

Create `tests/mem9/integration/migration.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { runMigrateToMem9 } from "../../../src/cli/migrate-to-mem9-command";

const MEM9_URL = process.env.MEM9_URL;
const RUN_MIGRATION = process.env.RUN_MIGRATION === "1";

describe.skipIf(!MEM9_URL || !RUN_MIGRATION)("mem9 integration: migration", () => {
  test("migrates existing SQLite DB without throwing", async () => {
    // preconditions:
    // - MEM9_URL points at a clean mem9 instance
    // - ~/.claude-mem/claude-mem.db exists and has data
    // - RUN_MIGRATION=1 opt-in (destructive to the mem9 instance)
    await expect(runMigrateToMem9()).resolves.toBeUndefined();
  });
});
```

This test is gated behind `RUN_MIGRATION=1` because it writes real data to mem9. Run manually during Phase 1 acceptance, not in CI.

- [ ] **Step 15.3: Smoke-test manually against a live mem9 server**

With a populated `~/.claude-mem/claude-mem.db` and `MEM9_URL` set:
```
npm run build
npx claude-mem migrate-to-mem9
```
Expected: counts print, marker file appears, no errors.

- [ ] **Step 15.4: Commit**

```bash
git add src/cli/migrate-to-mem9-command.ts src/cli/index.ts
git commit -m "feat(mem9): add migrate-to-mem9 CLI command"
```

---

## Task 16: Parity test harness

**Why last:** needs Mem9Store + Mem9Search in place. Validates that swapping the backend doesn't regress search quality.

**Files:**
- Create: `tests/mem9/parity/golden-queries.test.ts`
- Create: `tests/mem9/parity/fixtures.json` (20 golden queries)

- [ ] **Step 16.1: Capture golden queries**

Create `tests/mem9/parity/fixtures.json`:

```json
{
  "queries": [
    { "query": "bug fix", "project": "demo" },
    { "query": "migration", "project": "demo" },
    { "query": "test coverage", "project": "demo" }
  ]
}
```

Populate this with 20 real query/project pairs captured from actual dogfooding usage. Don't fabricate — pull from your own past search usage. If you don't have 20, start with 5 and expand over the Phase 1 pilot.

- [ ] **Step 16.2: Write parity test**

```typescript
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
```

- [ ] **Step 16.3: Run**

```
MEM9_URL=http://localhost:8080 RUN_PARITY=1 bun test tests/mem9/parity/
```

- [ ] **Step 16.4: Commit**

```bash
git add tests/mem9/parity/
git commit -m "test(mem9): parity harness for golden query set"
```

---

## Verification / smoke-test

After all tasks are complete, run the full suite:

```bash
bun test                     # all unit tests pass, integration tests skipped without MEM9_URL
bun run build                # project builds
bun run worker:restart       # worker boots with MEM9_URL unset → legacy path
```

Then with `MEM9_URL` set to a real mem9 server:

```bash
MEM9_URL=http://localhost:8080 bun run worker:restart
# → worker logs "mem9 healthy at ..."
# → trigger a session (any Claude Code interaction)
# → verify observations appear in mem9 (via mem9's own UI or `curl $MEM9_URL/memories`)
# → hit the viewer UI at http://localhost:37777 — feed shows observations served from mem9
```

Manual acceptance checklist (from the spec):
- [ ] Fresh install with `MEM9_URL` unset → worker boots normally, uses SQLite+Chroma.
- [ ] `MEM9_URL` set but unreachable → worker exits with clear error.
- [ ] `MEM9_URL` set and reachable → writes go to mem9, reads come from mem9.
- [ ] `claude-mem migrate-to-mem9` runs clean against a populated DB, counts match, marker file appears.
- [ ] Viewer UI feed, timeline, and semantic search are visually equivalent to today.
- [ ] `<private>` tag content still never leaves the hook layer (spot-check: trigger a session with `<private>…</private>` content, verify it doesn't appear in mem9).

Performance baselines (capture once, paste into PR description):
- Observation write P50 (target ≤ 500ms).
- Search latency P50 (target ≤ 3× today's Chroma times).
- Over-fetch selectivity on golden queries (target ≥ 50% median).

---

## Scope guardrails

- **Do not** delete any SQLite or Chroma code in this plan. That's Phase 3.
- **Do not** change the viewer UI. It talks to `/api/*` which is unchanged.
- **Do not** change the hook layer. `<private>` tag stripping stays exactly where it is.
- **Do not** introduce new runtime dependencies. If the plan tempts you to add an npm package, stop and reconsider — the spec says "no new deps beyond Bun's fetch."
- **If you discover** the mem9 POST /memories payload differs from what this plan assumes, update `Mem9Client.store()` + its tests ONLY. Do not rewrite upstream modules.
- **Pending-message queue stays on SQLite in Phase 1**, even when `MEM9_URL` is set. Rationale: pending_messages is per-worker operational queue state, not memory. The spec's mem9-backed pending-message design (with in-process cache) requires more consumer surgery than Phase 1 feature-flagging warrants. `Mem9Store.storePendingMessage` exists for the migration CLI (historical records) but is not wired into the hot write path. A dedicated Phase 2 task will move the live queue to mem9.
- **Session lifecycle writes stay on SQLite in Phase 1** (Task 11b deferred). Rationale: session writes do not live in `SessionManager.ts` as the plan originally assumed — they live in `SessionRoutes.ts` (`handleSessionInitByClaudeId`) and `SessionCompletionHandler.ts` (`markSessionCompleted`). Branching them requires (a) a new `mem9_id` column in `sdk_sessions` so the mem9 id can be retrieved later for updates, and (b) touching a multi-file surface including schema migration. This is too large for a Phase-1 feature-flag task. The `Mem9Store.storeSession` / `updateSession` methods exist and are covered by Task 14's integration test. Session records in mem9 will appear via the Task 15 migration CLI (for historical records) and via a Phase 2 task that properly wires the live path.
- **Legacy Chroma backfill continues to run** on worker boot even when mem9 is active, because it's in the SQLite+Chroma code path that's gated by `MEM9_URL` being unset. If this costs noticeable startup time, guard the backfill with `!Mem9Manager.isEnabled()` as a separate commit.
