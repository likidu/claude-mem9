import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadMem9Config, isMem9Enabled } from "../../src/services/mem9/config";

describe("mem9 config", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.MEM9_URL;
    delete process.env.MEM9_API_KEY;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("isMem9Enabled returns false when MEM9_URL unset", () => {
    expect(isMem9Enabled()).toBe(false);
  });

  test("isMem9Enabled returns true when MEM9_URL set", () => {
    process.env.MEM9_URL = "http://localhost:8080";
    expect(isMem9Enabled()).toBe(true);
  });

  test("loadMem9Config returns URL and optional API key", () => {
    process.env.MEM9_URL = "http://localhost:8080";
    process.env.MEM9_API_KEY = "secret";
    const cfg = loadMem9Config();
    expect(cfg.url).toBe("http://localhost:8080");
    expect(cfg.apiKey).toBe("secret");
  });

  test("loadMem9Config throws when MEM9_URL unset", () => {
    expect(() => loadMem9Config()).toThrow(/MEM9_URL/);
  });

  test("loadMem9Config strips trailing slash from URL", () => {
    process.env.MEM9_URL = "http://localhost:8080/";
    expect(loadMem9Config().url).toBe("http://localhost:8080");
  });
});
