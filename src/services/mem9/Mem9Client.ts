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
    if (this.cfg.apiKey) h["Authorization"] = `Bearer ${this.cfg.apiKey}`;
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
}
