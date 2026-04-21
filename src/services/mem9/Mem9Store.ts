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
    // Tag parent with a client-generated correlation key. Public mem9 (api.mem9.ai)
    // returns {status: accepted} without the memory ID, so we can't use the
    // server-assigned id for the parent→field relationship. Use the client UUID
    // that already appears in field tags (parent:${obs.id}) and mirror it on the
    // parent as self:${obs.id}. Query-time dedup joins on this tag.
    const parentWithSelfTag = {
      ...parent,
      tags: [...parent.tags, `self:${obs.id}`],
    };
    const parentId = await this.client.store(parentWithSelfTag);
    try {
      // Fields already carry the correct parent:${obs.id} tag from mapping.ts —
      // don't rewrite with the server id because we may not have one.
      await Promise.all(fields.map((f) => this.client.store(f)));
      return parentId || obs.id;
    } catch (err) {
      // Best-effort rollback. If parentId is falsy (api.mem9.ai async path),
      // we can't reach the parent — leave orphans for a future GC pass.
      if (parentId) await this.client.delete(parentId).catch(() => {});
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
