# Phase 2a — Mem9Client Backend Generalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize `Mem9Client` to support both `api.mem9.ai` (default) and self-hosted `mnemo-server` via a `MEM9_BACKEND` env var. All other mem9 modules stay backend-agnostic.

**Architecture:** A new `backend: "public" | "self-hosted"` field on `Mem9Config` drives two small adapters inside `Mem9Client` only — the auth header and the POST response parser. `search()` already tolerates both GET response shapes from Phase 1's public-API fix. No changes outside `src/services/mem9/` and `tests/mem9/`.

**Tech Stack:** TypeScript (ESM), Bun runtime, `bun test`, Bun's built-in `fetch`. No new dependencies.

**Source spec:** `docs/superpowers/specs/2026-04-21-mem9-phase2a-client-generalization-design.md`

**Verified contract differences (from Phase 1 testing + source inspection — do not re-verify):**

| | Public (`api.mem9.ai`) | Self-hosted (`mnemo-server`) |
|---|---|---|
| Auth header | `X-API-Key: <key>` | `Authorization: Bearer <key>` |
| POST /memories | `{status: "accepted"}` | `{id: "...", content, tags, …}` |
| GET /memories | `{memories: [...]}` | `{results: [...]}` |

**Invariants preserved:**
- All 30 existing Phase 1 unit tests must continue to pass.
- `backend` discriminant stays inside `Mem9Client`; does NOT route through `Mem9Manager`, `Mem9Store`, `Mem9Search`, or anywhere else.
- Default (when `MEM9_BACKEND` unset) is `"public"` — zero-config for the common case.
- Manual verification against `api.mem9.ai` continues to work post-change.

---

## File Structure

### Modified files
- `src/services/mem9/config.ts` — add `Mem9Backend` type + `backend` field + resolver.
- `src/services/mem9/Mem9Client.ts` — branch `headers()` + adapt `store()`.
- `tests/mem9/config.test.ts` — add 3 backend-resolution tests.
- `tests/mem9/Mem9Client.test.ts` — update all existing config literals to include `backend: "public"`, add 6 new tests.

### New files
- `tests/mem9/fixtures/public-api-responses.json` — captured shapes from `api.mem9.ai`.
- `tests/mem9/fixtures/self-hosted-responses.json` — documented shapes from mnemo-server source.

---

## Task 1: Config — add `Mem9Backend` type + resolver

**Why first:** `Mem9Client` imports `Mem9Config` from `config.ts`. Every other task depends on the new `backend` field being defined first.

**Files:**
- Modify: `src/services/mem9/config.ts`
- Modify: `tests/mem9/config.test.ts`

- [ ] **Step 1.1: Write failing tests for backend resolution**

Open `tests/mem9/config.test.ts`. Append these 3 tests before the final closing brace of the outer `describe("mem9 config", …)`:

```typescript
  test("loadMem9Config defaults backend to 'public' when MEM9_BACKEND unset", () => {
    process.env.MEM9_URL = "http://mem9";
    expect(loadMem9Config().backend).toBe("public");
  });

  test("loadMem9Config respects MEM9_BACKEND=self-hosted", () => {
    process.env.MEM9_URL = "http://mem9";
    process.env.MEM9_BACKEND = "self-hosted";
    expect(loadMem9Config().backend).toBe("self-hosted");
  });

  test("loadMem9Config falls back to 'public' for unknown MEM9_BACKEND values", () => {
    process.env.MEM9_URL = "http://mem9";
    process.env.MEM9_BACKEND = "weird";
    expect(loadMem9Config().backend).toBe("public");
  });
```

Also update the existing `beforeEach` in that file to also delete `process.env.MEM9_BACKEND`:

```typescript
  beforeEach(() => {
    delete process.env.MEM9_URL;
    delete process.env.MEM9_API_KEY;
    delete process.env.MEM9_BACKEND;
  });
```

- [ ] **Step 1.2: Run to verify failure**

Run: `bun test tests/mem9/config.test.ts`
Expected: 3 new tests fail — `loadMem9Config()` returns an object without a `backend` property, so `.backend` is undefined.

- [ ] **Step 1.3: Implement in `config.ts`**

Replace the contents of `src/services/mem9/config.ts` with:

```typescript
export type Mem9Backend = "public" | "self-hosted";

export interface Mem9Config {
  url: string;
  apiKey?: string;
  backend: Mem9Backend;
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
  const backend: Mem9Backend =
    process.env.MEM9_BACKEND === "self-hosted" ? "self-hosted" : "public";
  const config: Mem9Config = {
    url: raw.replace(/\/+$/, ""),
    backend,
  };
  if (process.env.MEM9_API_KEY) {
    config.apiKey = process.env.MEM9_API_KEY;
  }
  return config;
}
```

- [ ] **Step 1.4: Run all config tests**

Run: `bun test tests/mem9/config.test.ts`
Expected: All tests pass (existing 5 + new 3 = 8 pass, 0 fail).

- [ ] **Step 1.5: Run full mem9 test suite — expect client tests to FAIL**

Run: `bun test tests/mem9/`
Expected: `tests/mem9/config.test.ts` passes, but `tests/mem9/Mem9Client.test.ts` now has TypeScript errors / runtime failures because every `new Mem9Client({ url: "…", apiKey: … })` call is missing the required `backend` field. This is expected — Task 2 fixes it.

Do NOT commit until Task 2 is done (keeping the tree green per commit is the rule).

---

## Task 2: Update existing Mem9Client tests to include `backend` field

**Why:** Task 1 made `backend` a required field on `Mem9Config`. Every existing test that constructs a `Mem9Client` needs updating. This is a mechanical sweep — no new behavior.

**Files:**
- Modify: `tests/mem9/Mem9Client.test.ts`

- [ ] **Step 2.1: Replace every Mem9Client config literal**

Open `tests/mem9/Mem9Client.test.ts`. There are multiple occurrences of `new Mem9Client({ url: "…", apiKey: … })` throughout the file. Each needs `backend: "public"` added.

Use replace_all in the Edit tool with these exact find/replace pairs:

**Pair 1:** find `{ url: "http://mem9", apiKey: undefined }` → replace `{ url: "http://mem9", apiKey: undefined, backend: "public" }`

**Pair 2:** find `{ url: "http://mem9", apiKey: "secret" }` → replace `{ url: "http://mem9", apiKey: "secret", backend: "public" }`

If other literal shapes exist, add them with the same `backend: "public"` suffix. Every `Mem9Config` literal in the test file must include it.

- [ ] **Step 2.2: Run the full mem9 test suite**

Run: `bun test tests/mem9/`
Expected: 33 pass (30 original + 3 new config tests), 9 skip, 0 fail.

- [ ] **Step 2.3: Commit both tasks together**

```bash
git add src/services/mem9/config.ts tests/mem9/config.test.ts tests/mem9/Mem9Client.test.ts
git commit -m "feat(mem9): add backend discriminant to Mem9Config"
```

---

## Task 3: Create fixture files

**Why:** Fixtures document the two contract shapes in one place and feed Task 4–6 tests without inline JSON clutter.

**Files:**
- Create: `tests/mem9/fixtures/public-api-responses.json`
- Create: `tests/mem9/fixtures/self-hosted-responses.json`

- [ ] **Step 3.1: Create the fixtures directory and public fixture**

Create `tests/mem9/fixtures/public-api-responses.json`:

```json
{
  "auth_header_name": "X-API-Key",
  "POST_memories_response": { "status": "accepted" },
  "GET_memories_response": {
    "memories": [
      {
        "id": "e08338ea-2274-4109-90fc-3f4c49e3072f",
        "content": "sample memory content",
        "memory_type": "insight",
        "tags": ["kind:observation", "project:test-project"],
        "metadata": { "created_at_epoch": 1776811401 },
        "state": "active",
        "version": 2,
        "created_at": "2026-04-21T22:45:54Z",
        "updated_at": "2026-04-21T22:45:55Z",
        "relative_age": "just now"
      }
    ],
    "total": 1,
    "limit": 100,
    "offset": 0
  }
}
```

- [ ] **Step 3.2: Create the self-hosted fixture**

Create `tests/mem9/fixtures/self-hosted-responses.json`:

```json
{
  "auth_header_name": "Authorization",
  "auth_header_value_prefix": "Bearer ",
  "POST_memories_response": {
    "id": "mem-uuid-1234-5678-9abc-def012345678",
    "content": "sample memory content",
    "tags": ["kind:observation", "project:test-project"],
    "metadata": { "created_at_epoch": 1776811401 },
    "source": "test-project",
    "memory_type": "observation",
    "session_id": "sess-1",
    "state": "active",
    "version": 1,
    "created_at": "2026-04-21T22:45:54Z",
    "updated_at": "2026-04-21T22:45:54Z"
  },
  "GET_memories_response": {
    "results": [
      {
        "id": "mem-uuid-1234-5678-9abc-def012345678",
        "content": "sample memory content",
        "tags": ["kind:observation", "project:test-project"],
        "metadata": { "created_at_epoch": 1776811401 },
        "memory_type": "observation",
        "source": "test-project"
      }
    ]
  }
}
```

- [ ] **Step 3.3: Commit the fixtures**

```bash
git add tests/mem9/fixtures/
git commit -m "test(mem9): add backend contract fixtures"
```

---

## Task 4: `Mem9Client.headers()` backend branch

**Why:** This is the first client adapter. `store()` and `search()` rely on `headers()` being correct per-backend.

**Files:**
- Modify: `src/services/mem9/Mem9Client.ts`
- Modify: `tests/mem9/Mem9Client.test.ts`

- [ ] **Step 4.1: Write the failing test for self-hosted auth header**

Append to `tests/mem9/Mem9Client.test.ts` inside the `Mem9Client.store` describe block (after the existing `"includes X-API-Key header when apiKey set"` test):

```typescript
  test("includes Authorization: Bearer header when backend is self-hosted", async () => {
    let captured: HeadersInit | undefined;
    mockFetch(async (_, init) => {
      captured = init!.headers;
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    });
    const client = new Mem9Client({ url: "http://mem9", apiKey: "secret", backend: "self-hosted" });
    await client.store({ content: "x", tags: [], metadata: {} });
    expect((captured as Record<string, string>)["Authorization"]).toBe("Bearer secret");
    expect((captured as Record<string, string>)["X-API-Key"]).toBeUndefined();
  });

  test("public backend never sends Authorization header", async () => {
    let captured: HeadersInit | undefined;
    mockFetch(async (_, init) => {
      captured = init!.headers;
      return new Response(JSON.stringify({ status: "accepted" }), { status: 200 });
    });
    const client = new Mem9Client({ url: "http://mem9", apiKey: "secret", backend: "public" });
    await client.store({ content: "x", tags: [], metadata: {} });
    expect((captured as Record<string, string>)["Authorization"]).toBeUndefined();
    expect((captured as Record<string, string>)["X-API-Key"]).toBe("secret");
  });
```

- [ ] **Step 4.2: Run to verify failure**

Run: `bun test tests/mem9/Mem9Client.test.ts`
Expected: The `self-hosted` test fails because `Mem9Client.headers()` currently always emits `X-API-Key` (the Phase 1 public-API fix). The `public` test passes (it matches current behavior).

- [ ] **Step 4.3: Implement the branch in `Mem9Client.headers()`**

Open `src/services/mem9/Mem9Client.ts`. Find the `headers()` method (around lines 31-35, it currently sets `X-API-Key` unconditionally). Replace it with:

```typescript
  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.cfg.apiKey) {
      if (this.cfg.backend === "self-hosted") {
        h["Authorization"] = `Bearer ${this.cfg.apiKey}`;
      } else {
        h["X-API-Key"] = this.cfg.apiKey;
      }
    }
    return h;
  }
```

- [ ] **Step 4.4: Run tests**

Run: `bun test tests/mem9/Mem9Client.test.ts`
Expected: All tests pass (previous + 2 new = 11 pass, 0 fail).

- [ ] **Step 4.5: Commit**

```bash
git add src/services/mem9/Mem9Client.ts tests/mem9/Mem9Client.test.ts
git commit -m "feat(mem9): branch Mem9Client.headers() on backend"
```

---

## Task 5: `Mem9Client.store()` tolerates both POST response shapes

**Why:** Public returns `{status: "accepted"}` (no id); self-hosted returns `{id: "..."}`. Current code reads `json.id` unconditionally — works for self-hosted, silently returns `undefined` for public (which Phase 1 tolerates via tag-based correlation). Make it explicit: return the id when present, empty string otherwise.

**Files:**
- Modify: `src/services/mem9/Mem9Client.ts`
- Modify: `tests/mem9/Mem9Client.test.ts`

- [ ] **Step 5.1: Write failing tests for both POST response shapes**

Append to `tests/mem9/Mem9Client.test.ts` inside the `Mem9Client.store` describe block:

```typescript
  test("store() returns server id when self-hosted POST response has {id}", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ id: "mem-server-id-123" }), { status: 200 })
    );
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined, backend: "self-hosted" });
    const id = await client.store({ content: "x", tags: [], metadata: {} });
    expect(id).toBe("mem-server-id-123");
  });

  test("store() returns empty string when public POST response is {status: accepted}", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ status: "accepted" }), { status: 200 })
    );
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined, backend: "public" });
    const id = await client.store({ content: "x", tags: [], metadata: {} });
    expect(id).toBe("");
  });
```

- [ ] **Step 5.2: Run to verify failure**

Run: `bun test tests/mem9/Mem9Client.test.ts`
Expected: The `public` test fails (current `json.id` returns `undefined`, not `""`). The `self-hosted` test passes.

- [ ] **Step 5.3: Update `Mem9Client.store()`**

Open `src/services/mem9/Mem9Client.ts`. Find the `store()` method (around lines 63-70). Replace with:

```typescript
  async store(input: StoreInput): Promise<string> {
    const res = await this.request("/memories", {
      method: "POST",
      body: JSON.stringify(input),
    });
    const json = (await this.handle(res, "POST /memories")) as
      | { id: string }
      | { status: string };
    return "id" in json && typeof json.id === "string" ? json.id : "";
  }
```

The `typeof json.id === "string"` guard handles the edge case where a mistaken server returns `{id: null}` or similar.

- [ ] **Step 5.4: Run tests**

Run: `bun test tests/mem9/Mem9Client.test.ts`
Expected: All tests pass (13 pass, 0 fail).

- [ ] **Step 5.5: Commit**

```bash
git add src/services/mem9/Mem9Client.ts tests/mem9/Mem9Client.test.ts
git commit -m "feat(mem9): Mem9Client.store() tolerates both POST response shapes"
```

---

## Task 6: `Mem9Client.search()` tests verify both GET response shapes

**Why:** `search()` already returns `json.memories ?? json.results ?? []` from Phase 1's public-API patch (commit `56495953`). No code change — but we need explicit tests per backend that prove the fallback works for both, using the fixtures.

**Files:**
- Modify: `tests/mem9/Mem9Client.test.ts`

- [ ] **Step 6.1: Write failing tests for both GET response shapes**

Append to `tests/mem9/Mem9Client.test.ts` inside the `Mem9Client.search` describe block (after the existing `"builds GET /memories with query params and returns results"` test):

```typescript
  test("search() parses {memories: [...]} for public backend", async () => {
    const publicFixture = await import("./fixtures/public-api-responses.json");
    mockFetch(async () =>
      new Response(JSON.stringify(publicFixture.default.GET_memories_response), { status: 200 })
    );
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined, backend: "public" });
    const out = await client.search({ limit: 10 });
    expect(out.length).toBe(1);
    expect(out[0].id).toBe("e08338ea-2274-4109-90fc-3f4c49e3072f");
  });

  test("search() parses {results: [...]} for self-hosted backend", async () => {
    const selfHostedFixture = await import("./fixtures/self-hosted-responses.json");
    mockFetch(async () =>
      new Response(JSON.stringify(selfHostedFixture.default.GET_memories_response), { status: 200 })
    );
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined, backend: "self-hosted" });
    const out = await client.search({ limit: 10 });
    expect(out.length).toBe(1);
    expect(out[0].id).toBe("mem-uuid-1234-5678-9abc-def012345678");
  });
```

- [ ] **Step 6.2: Run tests**

Run: `bun test tests/mem9/Mem9Client.test.ts`
Expected: All tests pass (15 pass, 0 fail). No code change was needed — Phase 1's fallback already handles both shapes.

- [ ] **Step 6.3: Commit**

```bash
git add tests/mem9/Mem9Client.test.ts
git commit -m "test(mem9): verify Mem9Client.search() handles both GET response shapes"
```

---

## Final Verification

After Task 6 is done, run the full verification sweep:

```bash
# All mem9 tests pass
bun test tests/mem9/
# Expected: 39 pass (30 original + 3 config + 2 headers + 2 store + 2 search),
#           9 skip (integration + parity, require MEM9_URL), 0 fail.

# Nothing else broke
bun test
# Expected: same pre-existing failure count as before this plan started —
# all failures should be in files we did not touch.

# Commit history should show 5 atomic commits from this plan
git log --oneline mem9..HEAD
# Expected (order newest→oldest):
#   test(mem9): verify Mem9Client.search() handles both GET response shapes
#   feat(mem9): Mem9Client.store() tolerates both POST response shapes
#   feat(mem9): branch Mem9Client.headers() on backend
#   test(mem9): add backend contract fixtures
#   feat(mem9): add backend discriminant to Mem9Config
```

## Manual acceptance (optional, on VM)

Rebuild and redeploy the worker. Confirm the default path still works against `api.mem9.ai`:

```bash
cd ~/claude-mem9
git pull
npm run build-and-sync
sleep 3
grep "mem9 healthy" ~/.claude-mem/logs/claude-mem-$(date +%Y-%m-%d).log | tail -1
# Expected: "mem9 healthy at https://api.mem9.ai/..." (unchanged from before)

# Switch to self-hosted mode (no self-hosted server running → healthcheck must fail fast)
MEM9_BACKEND=self-hosted MEM9_URL=http://localhost:8080 npm run worker:restart --prefix ~/.claude/plugins/marketplaces/thedotmack
sleep 3
tail -n 5 ~/.claude-mem/logs/claude-mem-$(date +%Y-%m-%d).log
# Expected: "mem9 healthcheck failed: ..." then exit. Proves MEM9_BACKEND flag is wired.

# Restore default
unset MEM9_BACKEND
npm run worker:restart --prefix ~/.claude/plugins/marketplaces/thedotmack
```

## Merge

When all tasks are complete and verified:

```bash
git checkout mem9
git merge --no-ff mem9-phase2a
git branch -d mem9-phase2a
```

Then Phase 2b (write/read path completeness) branches off the updated `mem9`.

---

## Scope guardrails

- **Do not** modify `Mem9Manager`, `Mem9Store`, `Mem9Search`, or any hook/worker file. The backend discriminant lives inside `Mem9Client` only.
- **Do not** add retry, circuit breaker, or per-tenant auth logic.
- **Do not** add a live self-hosted integration test. That's Phase 3.
- **Do not** touch the migration CLI — it goes through `Mem9Manager` and stays agnostic.
- **Do not** attempt to detect the backend from the URL (heuristic). Use only the explicit `MEM9_BACKEND` env var.
- **If the test count math in Final Verification is off by one** because existing test counts shifted: trust the Task-by-Task "Expected" numbers — those are authoritative. The verification total is informational.

## Known pre-existing claude-mem base issues (not Phase 2 scope)

Discovered during Phase 2a live verification on the VM. These block live observation flow but are NOT regressions from Phase 1 or 2a — they exist in the base plugin upstream of our mem9 work. Park for Phase 3 or upstream contribution.

1. **SDK_SPAWN extractor flakiness.** Background `claude` subprocesses spawned by the worker to extract observation content from PostToolUse events get SIGTERM'd within 1-2 seconds of starting. Result: most sessions report `Drained N orphaned pending messages on session completion` and `obsCount=0`. Reproducible across all of Phase 1, Phase 2a testing on the public api.mem9.ai backend. Not caused by mem9 code — the extractor pool sits in `src/services/worker/SDKAgent.ts` and runs entirely upstream of `Mem9Store`.

2. **Build wipes `plugin/scripts/bun-runner.js`.** `npm run build` clears `plugin/scripts/` before writing built `.cjs` files, but `bun-runner.js` is a checked-in static source file in that same directory. Result: every fresh build deletes it, breaking the SessionStart and Stop hooks until restored. Workaround: `git checkout HEAD -- plugin/scripts/bun-runner.js` after each build, OR cherry-pick the file into the cache after sync. Real fix: `scripts/build-hooks.js` should preserve static files OR the static file should live elsewhere.
