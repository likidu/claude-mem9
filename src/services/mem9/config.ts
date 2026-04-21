export interface Mem9Config {
  url: string;
  apiKey?: string;
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
  const config: Mem9Config = {
    url: raw.replace(/\/+$/, ""),
  };
  if (process.env.MEM9_API_KEY) {
    config.apiKey = process.env.MEM9_API_KEY;
  }
  return config;
}
