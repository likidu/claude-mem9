import { Mem9Config } from "./config";
import { Mem9Unavailable, Mem9AuthError, Mem9NotFound, Mem9BadRequest } from "./errors";

export interface Mem9Memory {
  id: string;
  content: string;
  tags: string[];
  metadata: Record<string, unknown>;
  source?: string;
  state?: string;
  memory_type?: string;
  agent_id?: string;
  session_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface StoreInput {
  content: string;
  tags: string[];
  metadata: Record<string, unknown>;
  source?: string;
  memory_type?: string;
  agent_id?: string;
  session_id?: string;
}

export class Mem9Client {
  constructor(private readonly cfg: Mem9Config) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.cfg.apiKey) h["X-API-Key"] = this.cfg.apiKey;
    return h;
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(`${this.cfg.url}${path}`, {
        ...init,
        headers: { ...this.headers(), ...(init?.headers ?? {}) },
      });
    } catch (err) {
      throw new Mem9Unavailable(this.cfg.url, err);
    }
  }

  private async handle(res: Response, context: string): Promise<unknown> {
    if (res.status === 401 || res.status === 403) throw new Mem9AuthError();
    if (res.status === 404) throw new Mem9NotFound(context);
    if (res.status >= 400) {
      const body = await res.text().catch(() => "");
      throw new Mem9BadRequest(`${context} returned ${res.status}`, body);
    }
    return res.json();
  }

  async store(input: StoreInput): Promise<string> {
    const res = await this.request("/memories", {
      method: "POST",
      body: JSON.stringify(input),
    });
    const json = (await this.handle(res, "POST /memories")) as { id: string };
    return json.id;
  }

  async get(id: string): Promise<Mem9Memory> {
    const res = await this.request(`/memories/${encodeURIComponent(id)}`);
    return (await this.handle(res, id)) as Mem9Memory;
  }

  async update(id: string, patch: Partial<StoreInput>): Promise<void> {
    const res = await this.request(`/memories/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
    await this.handle(res, `PUT ${id}`);
  }

  async delete(id: string): Promise<void> {
    const res = await this.request(`/memories/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (res.status === 204) return;
    await this.handle(res, `DELETE ${id}`);
  }

  async search(input: SearchInput): Promise<Mem9Memory[]> {
    const params = new URLSearchParams();
    if (input.query) params.set("query", input.query);
    if (input.tags?.length) params.set("tags", input.tags.join(","));
    if (input.source) params.set("source", input.source);
    if (input.state) params.set("state", input.state);
    if (input.memoryType) params.set("memory_type", input.memoryType);
    if (input.agentId) params.set("agent_id", input.agentId);
    if (input.sessionId) params.set("session_id", input.sessionId);
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    if (input.offset !== undefined) params.set("offset", String(input.offset));
    if (input.minScore !== undefined) params.set("min_score", String(input.minScore));
    const res = await this.request(`/memories?${params.toString()}`);
    const json = (await this.handle(res, "GET /memories")) as { memories?: Mem9Memory[]; results?: Mem9Memory[] };
    return json.memories ?? json.results ?? [];
  }
}

export interface SearchInput {
  query?: string;
  tags?: string[];
  source?: string;
  state?: string;
  memoryType?: string;
  agentId?: string;
  sessionId?: string;
  limit?: number;
  offset?: number;
  minScore?: number;
}
