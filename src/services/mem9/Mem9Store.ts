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
