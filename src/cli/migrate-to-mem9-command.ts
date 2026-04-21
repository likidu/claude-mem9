/**
 * Migration CLI: reads existing SQLite DB and pushes records into mem9.
 *
 * Usage: npx claude-mem migrate-to-mem9
 *
 * Requires MEM9_URL to be set. Source SQLite DB is preserved — delete manually
 * once you trust the migration.
 */
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Mem9Manager } from "../services/mem9/Mem9Manager.js";
import type { ObservationEntity, SummaryEntity, PromptEntity, SessionEntity } from "../services/mem9/mapping.js";

const DEFAULT_DB_PATH = join(homedir(), ".claude-mem", "claude-mem.db");

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function runMigrateToMem9(): Promise<void> {
  if (!Mem9Manager.isEnabled()) {
    console.error("MEM9_URL is not set. Set MEM9_URL before running migrate-to-mem9.");
    process.exit(1);
  }

  const mem9 = new Mem9Manager();
  await mem9.healthcheck();
  console.log(`mem9 healthy at ${mem9.config.url}. Starting migration…`);

  const db = new Database(DEFAULT_DB_PATH, { readonly: true });

  // --- observations ---
  const obsRows = db.query("SELECT * FROM observations").all() as Record<string, unknown>[];
  let n = 0;
  for (const row of obsRows) {
    const obs: ObservationEntity = {
      id: String(row.id),
      memory_session_id: (row.memory_session_id as string) ?? null,
      project: (row.project as string) ?? "",
      type: (row.type as string) ?? "discovery",
      title: (row.title as string) ?? "",
      subtitle: (row.subtitle as string) ?? "",
      narrative: (row.narrative as string) ?? (row.text as string) ?? "",
      facts: parseJsonArray(row.facts as string),
      concepts: parseJsonArray(row.concepts as string),
      files_read: parseJsonArray(row.files_read as string),
      files_modified: parseJsonArray(row.files_modified as string),
      created_at_epoch: (row.created_at_epoch as number) ?? 0,
      prompt_number: (row.prompt_number as number) ?? null,
      discovery_tokens: (row.discovery_tokens as number) ?? null,
      content_hash: (row.content_hash as string) ?? null,
      merged_into_project: (row.merged_into_project as string) ?? null,
      agent_type: (row.agent_type as string) ?? null,
      agent_id: (row.agent_id as string) ?? null,
    };
    await mem9.store.storeObservation(obs);
    n++;
  }
  console.log(`observations: ${n}`);

  // --- session_summaries ---
  const sumRows = db.query("SELECT * FROM session_summaries").all() as Record<string, unknown>[];
  n = 0;
  for (const row of sumRows) {
    const summary: SummaryEntity = {
      id: String(row.id),
      memory_session_id: (row.memory_session_id as string) ?? "",
      project: (row.project as string) ?? "",
      request: (row.request as string) ?? "",
      investigated: (row.investigated as string) ?? "",
      learned: (row.learned as string) ?? "",
      completed: (row.completed as string) ?? "",
      next_steps: (row.next_steps as string) ?? "",
      files_read: parseJsonArray(row.files_read as string),
      files_edited: parseJsonArray(row.files_edited as string),
      notes: (row.notes as string) ?? "",
      created_at_epoch: (row.created_at_epoch as number) ?? 0,
      prompt_number: (row.prompt_number as number) ?? null,
      discovery_tokens: (row.discovery_tokens as number) ?? null,
      merged_into_project: (row.merged_into_project as string) ?? null,
    };
    await mem9.store.storeSummary(summary);
    n++;
  }
  console.log(`summaries: ${n}`);

  // --- user_prompts ---
  const promptRows = db.query("SELECT * FROM user_prompts").all() as Record<string, unknown>[];
  n = 0;
  for (const row of promptRows) {
    const prompt: PromptEntity = {
      id: String(row.id),
      content_session_id: (row.content_session_id as string) ?? "",
      prompt_text: (row.prompt_text as string) ?? "",
      prompt_number: (row.prompt_number as number) ?? 0,
      created_at_epoch: (row.created_at_epoch as number) ?? 0,
    };
    await mem9.store.storePrompt(prompt);
    n++;
  }
  console.log(`prompts: ${n}`);

  // --- sdk_sessions ---
  const sessionRows = db.query("SELECT * FROM sdk_sessions").all() as Record<string, unknown>[];
  n = 0;
  for (const row of sessionRows) {
    const session: SessionEntity = {
      id: String(row.id),
      content_session_id: (row.content_session_id as string) ?? "",
      memory_session_id: (row.memory_session_id as string) ?? "",
      project: (row.project as string) ?? "",
      status: (row.status as string) ?? "completed",
      platform_source: (row.platform_source as string) ?? "claude",
      started_at_epoch: (row.started_at_epoch as number) ?? 0,
      completed_at_epoch: (row.completed_at_epoch as number) ?? null,
      worker_port: (row.worker_port as number) ?? 0,
      prompt_counter: (row.prompt_counter as number) ?? 0,
    };
    await mem9.store.storeSession(session);
    n++;
  }
  console.log(`sessions: ${n}`);

  db.close();

  const marker = join(homedir(), ".claude-mem", ".migrated-to-mem9");
  writeFileSync(marker, `migrated_at=${new Date().toISOString()}\nmem9_url=${mem9.config.url}\n`);
  console.log(`Migration complete. Marker written to ${marker}.`);
  console.log("Original SQLite DB preserved — delete manually once you trust the migration.");
}
