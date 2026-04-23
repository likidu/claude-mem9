export type Mem9Backend = "public" | "self-hosted";

export interface Mem9Config {
  url: string;
  apiKey?: string;
  backend: Mem9Backend;
}

export function isMem9Enabled(): boolean {
  return typeof process.env.MEM9_URL === "string" && process.env.MEM9_URL.length > 0;
}

export function loadMem9Config(): Mem9Config {
  const raw = process.env.MEM9_URL;
  if (!raw) {
    throw new Error(
      "MEM9_URL is not set. Set MEM9_URL=http://your-mem9-server to enable the mem9 backend."
    );
  }
  const backend: Mem9Backend =
    process.env.MEM9_BACKEND === "self-hosted" ? "self-hosted" : "public";
  const config: Mem9Config = {
    url: raw.replace(/\/+$/, ""),
    backend,
  };
  if (process.env.MEM9_API_KEY) {
    config.apiKey = process.env.MEM9_API_KEY;
  }
  return config;
}
