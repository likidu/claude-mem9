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
