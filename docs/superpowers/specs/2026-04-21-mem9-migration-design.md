# Mem9 Migration Design

**Date:** 2026-04-21
**Status:** Approved — ready for implementation planning
**Author:** Brainstormed with Claude under `superpowers:brainstorming`

## Summary

Replace claude-mem's local storage stack — SQLite (`~/.claude-mem/claude-mem.db`) and Chroma (via `uvx chroma-mcp`) — with a mem9 client that talks to a user-provided `MEM9_URL` over HTTP. The plugin becomes stateless w.r.t. long-term storage; all memory lives in a mem9 server the user operates.

The deployment model is **user-provided server** (Approach B). The plugin fails fast with a clear error when `MEM9_URL` is unset or unreachable. There is no bundled/embedded fallback.

## Motivation

Intentional alignment with the [mem9](https://github.com/mem9-ai/mem9) project. Secondary wins:

- Eliminate the Python/uv/chroma-mcp dependency chain.
- Collapse two stores into one backend.
- Unlock cross-device / team-shared memory as a natural consequence of a server-backed store.

## Non-Goals

- Running mem9 for the user (no bundled server, no managed deployment).
- Permanent dual-backend mode (SQLite+Chroma and mem9 coexisting beyond migration).
- Pro-feature-specific work beyond reading from the same endpoints the core uses.
- Backwards dual-write after migration. Once migrated, the old stores are dead.

## Scope

**In scope:**

- Replace SQLite (7 tables) and Chroma (field-level projection) with mem9 memories.
- Map claude-mem entities onto mem9's flat memory model using typed metadata.
- Preserve semantic + full-text search using mem9's hybrid search.
- One-shot migration tool: read existing SQLite DB, push records into mem9.
- Update all 4 hubs (`SessionStore`, `SessionSearch`, `ChromaSync`, `SearchManager`) and ~15 dependents.
- Remove `better-sqlite3`, `uv`, `chroma-mcp` dependencies.

**Out of scope:**

- Running/hosting/managing mem9 infrastructure.
- Offline mode / write-ahead log (deferred to v2).
- Cross-region latency optimization.
- Load testing mem9 itself.

## Data Model Mapping

Every claude-mem record becomes a mem9 "memory" with typed metadata. All entity types share one mem9 namespace distinguished by a `kind` metadata field.

### mem9 filter surface (verified against source)

mem9's `memory_search` accepts only a flat, fixed-field filter (`server/internal/domain/types.go:67-78`). No `AND/OR`, no range predicates, no metadata-JSON predicates. The only filterable fields are:

| mem9 field | Shape | Usage in claude-mem |
|---|---|---|
| `Query` | FTS string | Free-text search term |
| `Tags` | OR list | `parent:<id>`, `project:<name>`, any multi-value filter we need |
| `Source` | equality | Origin marker (e.g., `claude-mem`) |
| `State` | equality | `active` / `archived` (mem9 lifecycle) |
| `MemoryType` | equality | `kind` (observation, summary, …) |
| `AgentID` | equality | Agent identifier |
| `SessionID` | equality | `memory_session_id` |
| `Limit`/`Offset`/`MinScore` | pagination/score gate | Standard |

Everything else travels in the memory's `metadata` JSON blob and is **client-side post-filtered** after fetch.

### Server-side filterable metadata

- `kind` → `MemoryType`
- `memory_session_id` → `SessionID`
- `agent_id` → `AgentID`
- `project` → `Source` (one project per Source value; project string sanitized as today)
- `parent_id` → `Tags` as `parent:<parent_memory_id>`

### Client-side post-filter metadata (stored in `metadata` JSON, filtered after fetch)

```
{
  content_session_id: string | null,
  prompt_number: number | null,
  created_at_epoch: number,
  content_hash: string | null,
  merged_into_project: string | null,
  observation_type: string | null,          // kind=observation
  agent_type: string | null,                // kind=observation
  rating: number | null,                    // kind=feedback
  feedback_tags: string[] | null,           // kind=feedback (renamed to avoid clashing with mem9 Tags)
  target_observation_id: string | null,     // kind=feedback
  session_status: string | null,            // kind=session
  worker_port: number | null,               // kind=session
  prompt_counter: number | null,            // kind=session
  pending_count: number | null,             // kind=pending_message
  last_check_epoch: number | null,          // kind=pending_message
}
```

**Implication:** queries like "observations in project X within time range Y" must over-fetch server-side (large `Limit`) and apply the time predicate in the client. Reads become a two-pass pattern documented in Data Flow.

### Entity mapping

| Claude-mem table | mem9 representation | Notes |
|---|---|---|
| `observations` | N memories per observation: 1 parent (kind=observation, full record) + N field memories (one per narrative/fact/concept), linked via `parent_id` | Preserves today's granular Chroma projection and field-level semantic match |
| `session_summaries` | 1 memory per summary (kind=summary) | Already structured; no split needed |
| `user_prompts` | 1 memory each (kind=user_prompt) | |
| `sdk_sessions` | 1 memory each (kind=session) | Updated via `memory_update` on lifecycle transitions |
| `observation_feedback` | 1 memory each (kind=feedback) | Links to target observation via `target_observation_id` |
| `pending_messages` | 1 memory each (kind=pending_message) | Cached in-process per worker; writes on state transition only |
| `schema_versions` | **Dropped** — mem9 has no schema | Plugin migration state tracked in local config if needed |

### Design decisions

1. **Granular projection preserved.** Observations still split into field-level memories so per-field semantic search matches today's UX.
2. **Joins become client-side searches.** What was `SELECT … WHERE memory_session_id = ?` becomes `memory_search` with a metadata filter, then dedup by `parent_id` in the client.
3. **Relational integrity is best-effort.** No foreign keys in mem9. Orphans are tolerated; periodic GC can be added if needed.
4. **Pending-message queue runs through mem9** with an in-process cache to avoid network RTT on the hot poll path.

## Architecture

> **Note:** this section describes the **Phase 3 end state**. During Phase 1 the old SQLite/Chroma code still exists, gated behind the feature flag (`MEM9_URL` unset → legacy path). See the Rollout section for the transition plan.

### New module

```
src/services/mem9/
  Mem9Client.ts          — thin REST wrapper (store/search/get/update/delete + retry + auth)
  Mem9Store.ts           — high-level write API matching today's SessionStore surface
  Mem9Search.ts          — search API matching today's SessionSearch surface
  mapping.ts             — entity ↔ memory converters per kind
  config.ts              — reads MEM9_URL, MEM9_API_KEY from env + settings.json
  errors.ts              — typed errors (Mem9Unavailable, Mem9AuthError, Mem9NotFound)
  healthcheck.ts         — boot-time probe; fails fast with a user-facing error
```

### Removed

- `src/services/sqlite/` — entire directory.
- `src/services/sync/` (ChromaSync, ChromaMcpManager) — entire directory.
- `DatabaseManager` renamed `Mem9Manager`; SQLite/Chroma init paths deleted.

### Kept but rewired

- `SearchManager` → calls `Mem9Search`. Hybrid search moves inside mem9, so `ChromaSearchStrategy` and `HybridSearchStrategy` collapse into one `Mem9SearchStrategy`.
- `ResponseProcessor` → calls `Mem9Store.storeObservation/storeSummary`. Writes block on mem9 ack; no more fire-and-forget sync.
- `SearchRoutes` → unchanged API shape; handlers delegate to new `SearchManager`.
- Viewer UI → unchanged (talks to the same `/api/*` endpoints).

### New CLI command

`claude-mem migrate-to-mem9` — one-shot migrator. See Data Flow.

### Worker boot sequence (Phase 3 end state)

```
Before: ensureSqliteDb → spawn chroma-mcp → listen
After:  loadMem9Config → healthcheck Mem9Url → listen
```

Healthcheck failure exits with a clear message pointing to `MEM9_URL` setup docs. No silent fallback.

During Phase 1, boot branches on `MEM9_URL`: present → new mem9 path; absent → legacy SQLite+Chroma path.

### Dependencies

Removed: `better-sqlite3`, `uv` bootstrap, `chroma-mcp` install logic.
Added: none — Bun's `fetch` is sufficient; we write a thin REST client rather than depend on any unofficial mem9 SDK.

## Data Flow

### Write path (observation)

```
Hook → worker HTTP → ResponseProcessor.parse()
  → Mem9Store.storeObservation(obs)
      → mapping.observationToMemories(obs)                    // parent + N field memories
      → Mem9Client.store(parent)                              // 1 RTT, returns parent_id
      → Promise.all(field[0..N].map(f => Mem9Client.store(f, {tags: [`parent:${parent_id}`]})))
  → returns memory id to caller
```

**No bulk endpoint.** Source inspection confirmed mem9's `POST /memories/bulk` handler exists but is not mounted (`server/internal/handler/handler.go:140-203`; dead code at `memory.go:504`). The only multi-memory request shape is `POST /memories` with a `messages: []` array, which triggers the LLM ingest/extract pipeline — not raw insert. Until upstream wires the bulk route, we fan out field-memory writes via `Promise.all`: 1 sequential RTT for the parent, then N parallel RTTs for fields. File upstream issue asking for the bulk route to be mounted.

**Atomicity:** field-store failure rolls back parent via `memory_delete`. No fire-and-forget.

### Read path (search)

```
GET /api/search?q=… → SearchRoutes → SearchManager.search()
  → Mem9Search.hybridSearch(q, {project, kind='observation', …filters})
      → split filters into server-side (MemoryType/SessionID/AgentID/Source/Tags) vs client-side
      → Mem9Client.search(q, serverFilters, limit: overfetch)
      → client-side post-filter (time range, merged_into_project, numeric predicates, …)
      → dedupe by parent_id
      → Mem9Client.get(parent_ids[]) for full records
  → response shape unchanged from today
```

**Two-pass pattern.** Because mem9's filter surface is flat equality on a fixed struct, queries with range predicates (time windows, numeric comparisons) or metadata-JSON predicates must over-fetch server-side and filter client-side. Over-fetch multiplier starts at 3× requested `limit` and is tuned against the parity test set. If a query's post-filter keeps < 20% of candidates, log a warning so we can consider moving that predicate into `Tags` encoding.

### Session lifecycle

```
session start → Mem9Store.createSession(kind=session, status=active)
prompt N     → Mem9Store.storePrompt(…)
                → Mem9Client.update(session_memory, {prompt_counter: N})
session end  → Mem9Client.update(session_memory, {status=completed, completed_at_epoch})
```

### Pending-message queue

```
enqueue:   Mem9Client.store(kind=pending_message, {memory_session_id, pending_count})
poll:      in-process cache (0-network on hot path)
drain:     Mem9Client.update(pending_count: 0)  OR  Mem9Client.delete(memory_id)
```

Writes to mem9 only on state transitions (enqueue, drain, session end). Single-worker-per-project invariant guarantees no cross-worker race on the cache.

### Migration path

```
claude-mem migrate-to-mem9
  → preflight: healthcheck MEM9_URL, confirm writable
  → open ~/.claude-mem/claude-mem.db read-only
  → for each table: map rows → memories → Mem9Client.store (batched)
  → write marker file ~/.claude-mem/.migrated-to-mem9 (timestamp + MEM9_URL)
  → report counts; preserve original DB file
```

User deletes the original `.db` manually after trusting the migration. Migrator does not delete.

### Error handling at boundaries

- `MEM9_URL` unset → worker fails boot with docs pointer.
- `MEM9_URL` unreachable at write time → hook returns exit 1 (non-blocking per project exit-code strategy); logs to user. No queue/retry in v1.
- Auth failure → same path.
- Partial write (parent stored, field failed) → roll back parent, log, return error.

## Testing Strategy

### Unit tests (`test/services/mem9/`)

- `mapping.test.ts` — round-trip `entity → memory → entity` for all 7 kinds + derived per-field memories.
- `Mem9Client.test.ts` — mocked fetch; retry, auth failure, 404, network error, rollback.
- `Mem9Search.test.ts` — mocked client; dedup by parent_id, filter composition, pagination.

### Integration tests (`test/integration/mem9/`)

Require `MEM9_URL`; skip cleanly when absent. CI runs one job with mem9, one without.

- `write-read-roundtrip.test.ts` — store observation, search it back, verify projection + dedup.
- `session-lifecycle.test.ts` — create/update/complete session + query by session.
- `migration.test.ts` — seed SQLite fixture, migrate to clean mem9, verify counts + spot-check.
- `healthcheck.test.ts` — boot succeeds iff mem9 reachable; fails fast otherwise with the right error.

### Parity tests (`test/parity/`)

50 real observations/summaries captured from current dogfooding. Run today's SQLite+Chroma search and new Mem9Search over identical input. For each of 20 golden queries, diff top-10 results. No missing observations = pass; ordering differences flagged but allowed.

### Manual acceptance

- Fresh install with unset `MEM9_URL` → worker exits with helpful error.
- Fresh install with `MEM9_URL` set → worker boots, hooks store memories, viewer shows them.
- Existing install → `claude-mem migrate-to-mem9` runs clean, counts match.
- Viewer UI feed, timeline, semantic search visually equivalent to today.
- Search skill returns equivalent results on a held-out query set.

### Performance baselines

- Observation write latency: budget ≤ **500ms P50** (revised upward from 200ms after confirming no bulk endpoint — writes are 1 sequential RTT for parent plus N parallel RTTs for field-memories; on a typical observation with ~5 fields and 50ms RTT this lands around 100ms + 50ms = 150ms, leaving headroom).
- Search latency on 10k-observation corpus: within **3×** today's Chroma times (revised from 2× to account for over-fetch + client-side post-filter).
- Pending-message poll: 0 network on hot path (cache hit).
- Over-fetch efficiency: median post-filter selectivity ≥ 50% on the parity golden-query set.

### Out of v1 testing

- mem9 server availability under load (user's infra).
- Cross-region latency.
- Concurrent writer conflicts beyond single-worker-per-project.

## Risks & Mitigations

1. **mem9 API instability (highest).** No tagged releases. *Mitigation:* pin to a commit SHA; write client against a captured contract; integration tests run against the pinned version.
2. **Per-write latency regression.** Network RTT vs SQLite's ~1ms, compounded by the N+1-writes-per-observation pattern with no bulk endpoint available. *Mitigation:* parallelize field-memory writes via `Promise.all`; file an upstream ask to mount the existing (dead) `bulkCreateMemories` handler at `server/internal/handler/memory.go:504`; if upstream declines, evaluate a short-lived fork or move observations to a single mem9 memory with field-level content concatenated (would lose field-granularity in search).
3. **No offline mode.** *Mitigation:* accept in v1; document; v2 adds write-ahead log.
4. **Privacy surface change.** `<private>` stripping at hook layer unchanged, but untagged content now leaves the machine. *Mitigation:* docs + README updates; keep `<private>` path audited.
5. **Pending-message semantics.** Queue-ish state in a memory store. *Mitigation:* in-process cache; single-worker-per-project invariant.
6. **Migration non-reversible.** *Mitigation:* migrator preserves original `.db`; back-out path documented.
7. **Viewer mem9 auth.** *Mitigation:* viewer keeps talking to local worker only; worker holds the mem9 credential. No UI change.

## Rollout

- **Phase 0:** this spec — approved.
- **Phase 1:** implement behind a feature flag — `MEM9_URL` set enables new path, absent falls back to SQLite+Chroma. Pre-release. Internal dogfooding.
- **Phase 2:** flip default — missing `MEM9_URL` becomes a boot error. Legacy path gated behind `CLAUDE_MEM_LEGACY=1` for one release.
- **Phase 3:** delete SQLite + Chroma code. Drop `better-sqlite3` and `uv` bootstrap. Bump major version.

Phase 1 is the only stage where a hybrid (dual-backend) mode exists — a migration-only concession, not a permanent mode.

**Phase 1 is the primary target for the implementation plan.** Phase 2 (flag flip) and Phase 3 (code removal) are follow-up plans, each with their own spec or plan at the appropriate time.

## Verified Answers from mem9 Source

Investigated against the live mem9 repo. Evidence cited inline.

- **Bulk `memory_store`? No.** The router at `server/internal/handler/handler.go:140-203` mounts single-memory routes only. `bulkCreateMemories` exists at `server/internal/handler/memory.go:504` and `MemoryService.BulkCreate` at `server/internal/service/memory.go:863` (with `maxBulkSize=100`), but the route is never wired. The CLI and `docs/DESIGN.md:501` reference `POST /memories/bulk` — but the server does not route it. Action: we parallelize client-side via `Promise.all`; file upstream issue asking for the route to be mounted.

- **Filter expression language? No — flat equality on a fixed struct plus one FTS string.** `domain.MemoryFilter` at `server/internal/domain/types.go:67-78` defines `Query, Tags (OR), Source, State, MemoryType, AgentID, SessionID, Limit, Offset, MinScore`. No `AND/OR/NOT`, no range predicates, no metadata-JSON predicates. A "project=X AND created_at BETWEEN a AND b AND kind IN (…)" query is not expressible server-side. Spec reflects this via the two-pass read path (see Data Flow).

- **Native `parent_id`? No.** Schemas `server/schema.sql:27-56`, `server/schema_pg.sql:29-50`, `schema_db9.sql` define `memories(id, content, source, tags, metadata, embedding, memory_type, agent_id, session_id, state, version, updated_by, created_at, updated_at, superseded_by)`. Only cross-row link is `superseded_by` (linear revision chain). No `parent_id`, no `thread_id`, no relations table. Parent/child is entirely client-side via `metadata` JSON or `tags`. Spec encodes parent as `tags: [\`parent:<id>\`]` so it becomes server-side filterable.

## Open Questions

Remaining items for Phase 1 to verify:

- License compatibility: mem9 Apache-2.0 is compatible with claude-mem's license (verify the claude-mem LICENSE during Phase 1).
- Source/project semantics: mem9's `Source` field is free-form equality; confirm it's safe to use as the primary project partition (vs multi-tenant isolation).
- State lifecycle: mem9's `State` field has semantics (`active`/`archived`) we need to align with claude-mem's `merged_into_project` concept.

## Success Criteria

- Parity tests pass on the golden query set.
- P50 write latency ≤ 200ms.
- P50 search latency within 2× today's.
- Zero regressions on manual acceptance checklist.
- Install footprint smaller: no Python, no uv, no chroma-mcp subprocess.
- Migration tool reports 100% row-count match and passes spot-check.

## References

- mem9 repository: https://github.com/mem9-ai/mem9
- Current SQLite layer: `src/services/sqlite/` (SessionStore.ts:34, SessionSearch.ts:1)
- Current Chroma layer: `src/services/sync/ChromaSync.ts:758`, `ChromaMcpManager.ts:120`
- Exit code strategy: see `CLAUDE.md` and `private/context/claude-code/exit-codes.md`
