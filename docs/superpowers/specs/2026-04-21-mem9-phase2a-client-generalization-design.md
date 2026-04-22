# Phase 2a — Mem9Client Backend Generalization

**Date:** 2026-04-21
**Status:** Approved — ready for implementation planning
**Author:** Brainstormed with Claude under `superpowers:brainstorming`
**Parent:** `docs/superpowers/specs/2026-04-21-mem9-migration-design.md` (original Phase 1 spec)

## Summary

Generalize `Mem9Client` so it works against two backends: the hosted **public** service at `api.mem9.ai` (default) and a **self-hosted** mnemo-server instance. Backend mode is selected via the `MEM9_BACKEND` env var. All other mem9 modules (`Mem9Store`, `Mem9Search`, `Mem9Manager`) stay backend-agnostic.

Phase 1 hardcoded the client to the public service after live testing revealed contract mismatches. Self-hosted support was always in-scope per the original Phase 1 spec but only got contract-adapter patches on a throwaway branch. This phase makes both contracts first-class.

## Motivation

- Users running a local mnemo-server (per the mem9 project's own docs) currently can't use this plugin without editing `Mem9Client.ts`.
- The two contracts are fully knowable (documented in the source inspection and the live public-service probes), so we can support both without speculation.
- Generalizing now, before Phase 2b's larger write/read work, means Phase 2b builds on a solid client abstraction instead of redoing the work later.

## Non-Goals

- Adding a live integration test against self-hosted mnemo-server. Covered by fixture tests only in this phase. A docker-compose rig for live self-hosted testing is explicitly Phase 3 or later.
- Any write-path or read-path semantic change beyond contract adapters.
- Retry, circuit breaker, or per-tenant auth logic.
- Changing how mem9 IDs are propagated (Phase 1 uses client-generated UUIDs in tags — unchanged).
- Routing the `backend` value through `Mem9Manager`, `Mem9Store`, or `Mem9Search` — only `Mem9Client` reads it.

## Verified Contract Differences

Both contracts confirmed — public via live probes during Phase 1 VM testing, self-hosted via mem9 source inspection (`github.com/mem9-ai/mem9`, module path `github.com/qiffang/mnemos`).

| Aspect | Public (`api.mem9.ai`) | Self-hosted (`mnemo-server`) |
|---|---|---|
| **Auth header** | `X-API-Key: <key>` | `Authorization: Bearer <key>` |
| **POST /memories response** | `{status: "accepted"}` (async, no id) | `{id, content, tags, metadata, …}` (sync, with id) |
| **GET /memories response** | `{memories: [...]}` | `{results: [...]}` |
| **Filter surface** | Same flat-equality fields (`Query, Tags, Source, …`) on both per source code |
| **Base URL example** | `https://api.mem9.ai/v1alpha2/mem9s` | e.g. `http://localhost:8080` |

## Scope

**In scope:**

- Add a `backend: "public" | "self-hosted"` field to `Mem9Config`.
- Extend `loadMem9Config()` to read `MEM9_BACKEND` env var; default to `"public"` when unset or unknown.
- Branch `Mem9Client.headers()` on backend for the auth header.
- Make `Mem9Client.store()` tolerate both POST response shapes (id optional; empty string returned when unavailable).
- Make `Mem9Client.search()` read from either `memories` or `results` (already done in Phase 1 fallback — keep).
- Add backend-specific tests to `tests/mem9/Mem9Client.test.ts` (3 per backend = 6 new).
- Add config tests for backend resolution (3 new).
- Capture contract fixtures under `tests/mem9/fixtures/` for documentation + reuse.
- Update this spec's supported-modes section in the parent Phase 1 spec or append a note.

**Out of scope:**

- See Non-Goals.
- No migration tooling changes (migration CLI already uses `Mem9Manager` → backend-agnostic).
- No viewer UI changes (no backend awareness exposed).

## File Structure

### Modified files

- `src/services/mem9/config.ts` — add `backend` discriminant and resolver.
- `src/services/mem9/Mem9Client.ts` — branch `headers()`, accept both POST shapes. `search()` already handles both GET shapes from Phase 1's public-API patch.
- `tests/mem9/config.test.ts` — new tests for backend resolution.
- `tests/mem9/Mem9Client.test.ts` — new tests per backend.

### New files

- `tests/mem9/fixtures/public-api-responses.json` — captured shapes from `api.mem9.ai`.
- `tests/mem9/fixtures/self-hosted-responses.json` — documented shapes from mnemo-server source.

## Architecture

### Config

```typescript
// src/services/mem9/config.ts

export type Mem9Backend = "public" | "self-hosted";

export interface Mem9Config {
  url: string;
  apiKey?: string;
  backend: Mem9Backend;
}

export function loadMem9Config(): Mem9Config {
  const raw = process.env.MEM9_URL;
  if (!raw) {
    throw new Error(
      "MEM9_URL is not set. Set MEM9_URL=<your-mem9-server> to enable the mem9 backend."
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

Behavior:
- `MEM9_BACKEND=self-hosted` → self-hosted mode.
- Anything else (unset, `public`, `""`, `weird`) → public mode. Fail-open default.

### Client

```typescript
// src/services/mem9/Mem9Client.ts

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

async store(input: StoreInput): Promise<string> {
  const res = await this.request("/memories", {
    method: "POST",
    body: JSON.stringify(input),
  });
  const json = (await this.handle(res, "POST /memories")) as
    | { id: string }
    | { status: string };
  return "id" in json ? json.id : "";
}
```

`search()` already returns `json.memories ?? json.results ?? []` from Phase 1's public-API patch — no change.

**Return-value semantics for `store()`:**
- Self-hosted returns the server-assigned id.
- Public returns `""` (empty string). Callers that care about the id use the client-generated UUID via tags (already the Phase 1 pattern).
- `Mem9Store.storeObservation` already guards `if (parentId)` before rollback — no change needed.

### No other module changes

`Mem9Manager`, `Mem9Store`, `Mem9Search`, the migration CLI, hooks, and the viewer all stay as-is. The backend difference lives entirely inside `Mem9Client`.

## Data Flow

No semantic change to write or read paths. The client transparently adapts:

```
Mem9Store.storeObservation(obs)
  → Mem9Client.store(parentMemory)
      → request("POST /memories", body)
      → fetch(url, { headers: {X-API-Key or Authorization: Bearer based on backend} })
      → parse {status} OR {id} based on response
      → return id-or-empty-string
```

```
Mem9Search.searchObservations(input)
  → Mem9Client.search(filters)
      → request("GET /memories?…")
      → parse {memories} OR {results} from response
      → return unified Mem9Memory[]
```

## Testing Strategy

### Unit tests

**`tests/mem9/config.test.ts` (3 new tests):**

1. `backend` defaults to `"public"` when `MEM9_BACKEND` unset.
2. `MEM9_BACKEND=self-hosted` → `backend: "self-hosted"`.
3. Unknown values (`MEM9_BACKEND=weird`, `MEM9_BACKEND=""`) → default to `"public"` (fail-open).

**`tests/mem9/Mem9Client.test.ts` (6 new tests, organized by backend):**

Public backend (3):
- `store()` uses `X-API-Key` header when `apiKey` present and `backend === "public"`.
- `store()` returns `""` when POST response is `{status: "accepted"}`.
- `search()` parses `{memories: [...]}` response.

Self-hosted backend (3):
- `store()` uses `Authorization: Bearer` header when `backend === "self-hosted"`.
- `store()` returns the `id` when POST response is `{id: "..."}`.
- `search()` parses `{results: [...]}` response.

Existing tests retain their public-default shape — they still pass unchanged.

### Fixture files

`tests/mem9/fixtures/public-api-responses.json`:
```json
{
  "POST_memories_response": { "status": "accepted" },
  "GET_memories_response": {
    "memories": [
      {
        "id": "e08338ea-...",
        "content": "...",
        "memory_type": "insight",
        "tags": ["kind:observation", "project:test"],
        "metadata": { "created_at_epoch": 123 },
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
  },
  "auth_header": "X-API-Key"
}
```

`tests/mem9/fixtures/self-hosted-responses.json`:
```json
{
  "POST_memories_response": {
    "id": "mem-uuid-1234",
    "content": "...",
    "tags": ["kind:observation"],
    "metadata": {},
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
        "id": "mem-uuid-1234",
        "content": "...",
        "tags": [],
        "metadata": {},
        "memory_type": "observation",
        "source": "test-project"
      }
    ]
  },
  "auth_header": "Authorization"
}
```

Tests import these fixtures and feed them through mocked `fetch` to exercise parsing.

### Out of test scope (documented gap)

- Live self-hosted integration. Deferred to Phase 3 (docker-compose rig) or first real user deployment.
- Live parity between backends on the same query set.

## Risks

1. **Silent empty-id propagation.** `store()` returns `""` in public mode; inherited from Phase 1. `Mem9Store` rollback already guards `if (parentId)`. No new risk.

2. **Backend misdetection via env.** User sets `MEM9_BACKEND=self-hosted` against `api.mem9.ai` (or vice versa). Auth fails at healthcheck, worker exits fast with clear error. No silent corruption.

3. **Discriminant creep.** Tempting to pass `backend` to `Mem9Store`/`Mem9Search` too — resist. Only `Mem9Client` reads it. Every other module stays contract-agnostic.

4. **Fixture drift.** If mem9's contracts change upstream, fixtures go stale. Mitigation: Phase 1's parity harness (`RUN_PARITY=1`) runs against live `api.mem9.ai` and catches public-API drift. No equivalent for self-hosted until Phase 3.

## Rollout

- Branch: `mem9-phase2a` off `mem9`.
- Target: merge to `mem9` when approved (same pattern as Phase 1 → `mem9`).
- Default behavior: unchanged for existing users (public mode).
- Opt-in: self-hosted users set `MEM9_BACKEND=self-hosted`.
- Phase 2b (write/read path completeness) branches from `mem9` after 2a merges.

## Success Criteria

- All existing Phase 1 tests still pass (no regressions).
- 9 new unit tests pass (3 config + 6 client).
- Two fixture files exist and are referenced by tests.
- Manual VM verification: `mem9 healthy` boot healthcheck succeeds against `api.mem9.ai` with `MEM9_BACKEND` unset (default public).
- Spec notes the two supported modes and flags self-hosted as fixture-tested only.

## References

- Parent spec: `docs/superpowers/specs/2026-04-21-mem9-migration-design.md`
- Phase 1 plan: `tasks/plan.md`
- Phase 1 merge commit: `cc1c9ed7` on `mem9`
- Phase 1 public-API fixes: `ae13a2d3` (X-API-Key), `56495953` (response-shape fallbacks) on `mem9`
- mem9 public service: https://mem9.ai, `https://api.mem9.ai/v1alpha2/mem9s`
- mem9 source: https://github.com/mem9-ai/mem9
