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
