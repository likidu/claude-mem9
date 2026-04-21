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
