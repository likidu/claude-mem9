# Phase 2b — Mem9 Write/Read Path Completeness

**Date:** 2026-04-26
**Status:** Approved — ready for implementation planning
**Author:** Brainstormed with Claude under `superpowers:brainstorming`
**Parents:**
- `docs/superpowers/specs/2026-04-21-mem9-migration-design.md` (Phase 1)
- `docs/superpowers/specs/2026-04-21-mem9-phase2a-client-generalization-design.md` (Phase 2a)

## Summary

Close six remaining Phase 1 debt items: SessionManager branch + schema migration (1), content-hash dedup on mem9 writes (4), `generated_by_model` field propagation (5), id-type widening (3), session/prompt search in mem9 (6), and Chroma backfill gating (8). One Phase 2b plan, one merge to `mem9`.

`pending_messages` (item 2) is **permanently** SQLite — not deferred to Phase 3, removed from scope. Per-worker queue state isn't memory; tag-based id resolution costs 2 RTTs per poll, which makes mem9 unsuitable for that workload.

Items 7 (mock-DI tests) and 9 (import-style sweep) are Phase 2c work.

## Motivation

Phase 1 left the mem9 write path partially wired: sessions, dedup, and `generated_by_model` were missing, and the read path returned empty `sessions:[]` and `prompts:[]` arrays. Phase 2a generalized the client to support both backends but didn't touch the higher-level data flow. Phase 2b closes the functional debt so the mem9 backend matches SQLite+Chroma behavior at the user level.

Net user-visible result after Phase 2b:
- Sessions appear in mem9 with proper lifecycle (active → completed).
- Duplicate observations are skipped on mem9 just like on SQLite.
- Search results in viewer/json show observations, sessions, AND prompts.
- Boot is faster when mem9 is active (Chroma backfill skipped).

## Non-Goals

- `pending_messages` live path — permanently SQLite (per architecture decision).
- Mock-DI unit tests for branches (Phase 2c).
- Import-style consistency sweep in `src/services/mem9/` (Phase 2c).
- Live self-hosted mnemo-server integration tests (Phase 3).
- Investigating SDK_SPAWN extractor flakiness (separate base-plugin issue, Phase 3+ or upstream).
- Fixing the build-script `bun-runner.js` wipe (separate base-plugin issue).
- Backfilling pre-existing SQLite session rows into mem9 (forward-only migration; legacy rows stay SQLite-only).
- Retry queues, periodic reconcilers, or self-healing for failed mem9 updates (best-effort log-and-continue).

## Verified Constraints

From Phase 2a live testing + source inspection:

| Concern | Public (`api.mem9.ai`) | Self-hosted (`mnemo-server`) |
|---|---|---|
| POST returns id? | No (`{status: "accepted"}`) | Yes (`{id, ...}`) |
| GET filter surface | flat equality + `Tags` OR-list | flat equality + `Tags` OR-list |
| PUT by id | Yes, `/memories/<id>` | Yes, `/memories/<id>` |

The asymmetric POST response is the architectural pivot for sessions and dedup.

## Scope

**In scope (6 items):**

1. **SessionManager branch** — write session memories on init; update on completion. Schema migration adds `sdk_sessions.mem9_id`. Tag-based id resolution handles the public no-id-on-POST case.
2. *(item 2 dropped — see Non-Goals)*
3. **`id` type widening** — `ObservationSearchResult.id: string | number`. Drop the `as unknown as number` cast.
4. **Content-hash dedup** — `hash:<sessionid>:<contenthash>` tag on observation parents. Pre-write search; skip if exists.
5. **`generated_by_model` field** — extend `ObservationEntity`; thread through metadata on parent + field memories.
6. **Session/prompt search in mem9** — `Mem9Search.searchSessions` and `searchPrompts`; wire into `SearchManager`'s mem9 branch.
8. **Chroma backfill gating** — wrap boot-time backfill in `if (!Mem9Manager.isEnabled())`.

**Invariants preserved:**
- All Phase 1 + 2a tests continue to pass.
- Default mode (`MEM9_URL` unset) byte-identical to today.
- Backend discriminant remains inside `Mem9Client` (Phase 2a invariant).
- `<private>` tag stripping at hook layer untouched.

## Architecture

### Schema migration

Add to `sdk_sessions`:

```sql
ALTER TABLE sdk_sessions ADD COLUMN mem9_id TEXT;
```

Idempotent via the project's existing `MigrationRunner` pattern (`ADD COLUMN IF NOT EXISTS` semantics through column-existence check). Forward-only — no backfill of historical rows.

### New module: `src/services/mem9/Mem9IdResolver.ts`

Encapsulates the "resolve server id from client UUID" pattern. Two public methods:

```typescript
export class Mem9IdResolver {
  constructor(private readonly client: Mem9Client) {}

  // Returns the server-assigned id for a memory tagged client_id:<uuid>,
  // or null if not found.
  async resolve(clientUuid: string): Promise<string | null>;

  // Stores a memory and returns the server id. On self-hosted (POST returns id)
  // returns it directly. On public, falls back to resolve(clientUuid) — with
  // one 500ms-delayed retry if the first search returns 0 results.
  async storeAndResolve(input: StoreInput, clientUuid: string): Promise<string | null>;
}
```

Returns `null` only when the public-mode resolve fails twice — caller treats this as a degraded mem9_id (write succeeded but later updates won't sync).

### `Mem9Store` extensions

Three new methods, additive:

```typescript
async storeSessionWithId(s: SessionEntity): Promise<string | null>;
async updateSessionById(serverMem9Id: string, patch: Partial<SessionEntity>): Promise<void>;
async storeObservationWithDedup(obs: ObservationEntity): Promise<string | "skipped">;
```

Existing `storeObservation`, `storeSummary`, etc. unchanged.

### `Mem9Search` extensions

```typescript
async searchSessions(input: { project?: string; sessionId?: string; query?: string; limit?: number }): Promise<SessionEntity[]>;
async searchPrompts(input: { project?: string; sessionId?: string; query?: string; limit?: number }): Promise<PromptEntity[]>;
```

Same two-pass over-fetch + post-filter pattern as `searchObservations`. Sessions and prompts have no parent/field split → simpler dedup.

### `mapping.ts` extensions

`ObservationEntity` gains:

```typescript
generated_by_model: string | null;
```

`observationToMemories(obs)`:
- Parent and every field memory: `metadata.generated_by_model = obs.generated_by_model`.
- Parent only: when `obs.content_hash` is set, add `hash:${obs.memory_session_id}:${obs.content_hash}` to `tags`.

`memoriesToObservation(parent, ...)`:
- Read `generated_by_model` from `parent.metadata`.

### Hub-point write branches

**`SessionRoutes.ts:handleSessionInitByClaudeId`** — after the existing `createSDKSession` call:

```typescript
const mem9 = this.dbManager.getMem9Manager();
if (mem9) {
  const clientUuid = crypto.randomUUID();
  const sessionEntity = buildSessionEntityFromInitParams(/* inline */);
  const serverMem9Id = await mem9.store.storeSessionWithId({
    ...sessionEntity,
    id: clientUuid,
  });
  if (serverMem9Id) {
    sessionStore.updateSessionMem9Id(sessionDbId, serverMem9Id);
  }
}
```

Failures logged, never thrown.

**`SessionCompletionHandler.ts:markSessionCompleted`** — wrap existing call:

```typescript
const mem9 = this.dbManager.getMem9Manager();
if (mem9) {
  const sessionRow = this.dbManager.getSessionStore().getSessionById(sessionDbId);
  if (sessionRow?.mem9_id) {
    await mem9.store.updateSessionById(sessionRow.mem9_id, {
      status: "completed",
      completed_at_epoch: Math.floor(Date.now() / 1000),
    }).catch((err) => log.warn(`mem9 session update failed: ${err}`));
  }
}
this.dbManager.getSessionStore().markSessionCompleted(sessionDbId);  // always runs
```

SQLite update always runs to preserve the `sessionDbId`-based parity used elsewhere in the worker.

**`SessionStore.ts`** — add:

```typescript
updateSessionMem9Id(id: number, mem9_id: string): void {
  this.db.prepare("UPDATE sdk_sessions SET mem9_id = ? WHERE id = ?").run(mem9_id, id);
}
```

**`ResponseProcessor.ts`** — in the existing mem9 branch, swap:

```typescript
// before
mem9.store.storeObservation(obs)
// after
mem9.store.storeObservationWithDedup(obs)
```

When the result is `"skipped"`, count it for telemetry (log line) but don't fail the loop.

### Hub-point read branches

**`SearchManager.ts`** — in the mem9 branch:

```typescript
const obs = await mem9.search.searchObservations({...});
const sessions = await mem9.search.searchSessions({ project, sessionId, query, limit });
const prompts = await mem9.search.searchPrompts({ project, sessionId, query, limit });
return this.formatSearchResponse({ observations: obs, sessions, prompts });
```

Drop the `as unknown as number` cast in `entityToSearchResult`. Map mem9's string id directly to `ObservationSearchResult.id` (now widened).

**`src/services/sqlite/types.ts`** — widen:

```typescript
interface ObservationSearchResult {
  id: string | number;  // was: number
  // ...
}
```

### Boot-time gating

**`worker-service.ts`** — wrap the existing `ChromaSync.backfillAllProjects(...)` call:

```typescript
if (!Mem9Manager.isEnabled()) {
  await ChromaSync.backfillAllProjects(/* ... */);
}
```

One-line guard. Saves 5-10s of cold-boot work when mem9 is active.

## Data Flow

### Session lifecycle

```
init:
  Claude Code → POST /api/sessions/init
  → SQLite: createSDKSession(...)              [returns sessionDbId numeric]
  → if mem9 active:
      clientUuid = crypto.randomUUID()
      sessionEntity = build inline (id = clientUuid)
      → storeSessionWithId(sessionEntity)
          → Mem9Client.store(memoryWithTag client_id:<uuid>)
          → if id returned: that's our serverMem9Id
          → else: search tags=[client_id:<uuid>], retry once on empty
      → sessionStore.updateSessionMem9Id(sessionDbId, serverMem9Id)
  → return { sessionDbId, ... }

complete:
  Claude Code → POST /api/sessions/complete
  → if mem9 active:
      row = sessionStore.getSessionById(sessionDbId)
      if row.mem9_id:
          → mem9.store.updateSessionById(row.mem9_id, { status: completed, completed_at_epoch })
            (errors logged, not thrown)
  → sessionStore.markSessionCompleted(sessionDbId)
```

**Failure modes (all log-and-continue, no rollback):**
- mem9 store fails → SQLite-only session.
- Tag resolution fails twice → `mem9_id=null` in SQLite; updates won't sync.
- mem9 update fails → stale `status:active` memory in mem9 (acceptable; cleanup is Phase 3+).

### Observation dedup

```
ResponseProcessor extracts labeledObservations
→ Promise.all over each obs:
    storeObservationWithDedup(obs):
      if obs.content_hash:
        hashTag = `hash:${obs.memory_session_id}:${obs.content_hash}`
        existing = await client.search({
          tags: [hashTag, `project:${obs.project}`],
          limit: 1,
        })
        if existing.length > 0: return "skipped"
      // fall through to existing storeObservation flow
```

Cross-project collisions impossible (`memory_session_id` is project-scoped UUID). Concurrent-write race exists but is moot under the single-worker-per-project invariant.

### `generated_by_model` propagation

```
existing modelId variable in ResponseProcessor
→ pass into ObservationEntity construction
→ mapping.observationToMemories writes metadata.generated_by_model on:
    parent memory
    every field memory
→ on read: memoriesToObservation reads from parent.metadata
```

No new tags. Pure metadata field.

### Sessions/prompts search

```
SearchManager.search → mem9 branch
  observations = await mem9.search.searchObservations(...)
  sessions = await mem9.search.searchSessions({ tags: ["kind:session", project, ...] })
  prompts = await mem9.search.searchPrompts({ tags: ["kind:user_prompt", project, ...] })
→ assemble json response: { observations, sessions, prompts, timings }
→ markdown formatter unchanged (already handles all three)
```

### Chroma backfill gating

```
worker-service.ts boot:
  → DatabaseManager.initialize()
  → if Mem9Manager.isEnabled(): healthcheck (Phase 1)
  → if !Mem9Manager.isEnabled(): ChromaSync.backfillAllProjects()  [GATED]
  → Express listen
```

## Testing Strategy

### Unit tests (~11 new)

**`tests/mem9/Mem9IdResolver.test.ts`** — 4 tests:
1. `resolve()` returns server id when search by `client_id:<uuid>` finds match.
2. `resolve()` returns null when no match.
3. `storeAndResolve()` returns server id from POST response when present (self-hosted).
4. `storeAndResolve()` falls back to resolve when POST response has no id (public).

**Extend `tests/mem9/Mem9Store.test.ts`** — 3 tests:
1. `storeSessionWithId()` writes the session memory and returns the resolved id.
2. `updateSessionById()` PUTs to `/memories/<id>` with the correct metadata patch.
3. `storeObservationWithDedup()` returns `"skipped"` when matching `hash:` tag exists; stores normally otherwise.

**Extend `tests/mem9/Mem9Search.test.ts`** — 2 tests:
1. `searchSessions()` filters by `kind:session` and maps to `SessionEntity[]`.
2. `searchPrompts()` filters by `kind:user_prompt` and maps to `PromptEntity[]`.

**Extend `tests/mem9/mapping.test.ts`** — 2 tests:
1. `observationToMemories` includes `hash:<sid>:<hash>` in parent tags when `content_hash` is set; omits when null.
2. `observationToMemories` propagates `generated_by_model` to parent + every field metadata; round-trips via `memoriesToObservation`.

### Schema migration test

Existing `tests/sqlite/migrations.test.ts` (or wherever migrations are tested):
- Assert `mem9_id` column exists on `sdk_sessions` post-migration.
- Idempotency: running migrations twice doesn't error.

### Integration tests

No new integration tests in 2b. The existing 9 skipped tests stay skipped; SDK_SPAWN flakiness blocks meaningful live runs regardless.

### Manual VM acceptance

- `bun test tests/mem9/` shows ~50 pass, 9 skip, 0 fail (~39 from Phase 1+2a + ~11 new).
- Schema check: `bun -e 'import { Database } from "bun:sqlite"; const db = new Database(...); console.log(db.query(".schema sdk_sessions").get())'` shows `mem9_id` column.
- Worker boot with `MEM9_URL` set: log shows `mem9 healthy`, NO `Backfill check` lines.
- Worker boot with `MEM9_URL` unset: log shows `Backfill check` (legacy path unchanged).
- Phase 1 + 2a tests still pass.

### Out of test scope

- End-to-end mem9 session round-trip (blocked by SDK_SPAWN flakiness).
- Concurrent-writer dedup race (single-worker invariant).
- Performance impact of 2-RTT id resolution (acceptable per design).

## Risks

1. **Schema migration on existing DBs.** Additive `ALTER TABLE`. Forward-only, idempotent via existing `MigrationRunner`. Won't break SQLite-only users — column stays null and is unread in the legacy path.

2. **2-RTT cost on session boot in mem9 mode.** ~200-400ms added. Acceptable per design. No mitigation needed.

3. **Indexing latency.** mem9 may not return a just-stored memory immediately on tag search. Mitigation: 500ms-delayed retry once; if still missing, log warning and store `mem9_id=null`. Sessions degrade gracefully (no future updates sync to mem9).

4. **`generated_by_model` metadata bloat.** Propagated to every field memory. Few KB per observation. Acceptable.

5. **`id` type widening ripples.** Phase 1 review audited consumers. No arithmetic on `id`, only string-interp. Removing the cast is safe.

6. **Chroma backfill gate.** One-line guard. When `MEM9_URL` unset, original call fires unchanged. Hard to break.

7. **Session-update best-effort mode.** Stale `status:active` memories accumulate over time when mem9 updates fail mid-session. Cleanup deferred to Phase 3+ (cron-style reconciler or manual `claude-mem cleanup-stale-sessions`).

## Rollout

- Branch: `mem9-phase2b` off `mem9`.
- Implementation: ~14 TDD tasks (more files than 2a's 6 because of schema + multiple hub points).
- Merge target: `mem9` branch (same pattern as Phase 1, 2a).
- Default behavior: unchanged for existing users (`MEM9_URL` unset → SQLite+Chroma + no Chroma backfill change).
- Mem9 users see: faster boot, sessions in mem9 with proper lifecycle, dedup honoring content_hash, sessions/prompts in search results.

## Success Criteria

- All Phase 1 + 2a unit tests still pass.
- ~11 new unit tests pass.
- `sdk_sessions.mem9_id` column exists post-migration; idempotent re-run.
- Manual VM check: mem9-active boot skips Chroma backfill; legacy boot runs it.
- Spec marks items 1, 3, 4, 5, 6, 8 as closed.

## Phase 2c Preview

Item 7 (mock-DI unit tests for branches) and item 9 (import-style consistency sweep). Pure cleanup, ~3 tasks total. Smallest of the three Phase 2 sub-phases.

## References

- Phase 1 spec: `docs/superpowers/specs/2026-04-21-mem9-migration-design.md`
- Phase 2a spec: `docs/superpowers/specs/2026-04-21-mem9-phase2a-client-generalization-design.md`
- Phase 2 grouping decision: brainstorming session prior to 2a (Approach 1: split 2a/2b/2c).
- Phase 2a merge: `b21da08d` on `mem9`.
- Known pre-existing issues note: `811827c2` on `mem9`.
