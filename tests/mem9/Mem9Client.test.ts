import { describe, test, expect, afterEach } from "bun:test";
import { Mem9Client } from "../../src/services/mem9/Mem9Client";
import { Mem9Unavailable, Mem9AuthError, Mem9NotFound } from "../../src/services/mem9/errors";

let activeRestore: (() => void) | null = null;

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): void {
  const original = globalThis.fetch;
  globalThis.fetch = impl as any;
  activeRestore = () => { globalThis.fetch = original; };
}

afterEach(() => {
  if (activeRestore) {
    activeRestore();
    activeRestore = null;
  }
});

describe("Mem9Client.store", () => {
  test("POSTs to /memories with content/tags/metadata and returns id", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    mockFetch(async (url, init) => {
      capturedUrl = url;
      capturedBody = init!.body as string;
      return new Response(JSON.stringify({ id: "mem-abc" }), { status: 200 });
    });
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined });
    const id = await client.store({ content: "hello", tags: ["t1"], metadata: { k: "v" } });
    expect(id).toBe("mem-abc");
    expect(capturedUrl).toBe("http://mem9/memories");
    expect(JSON.parse(capturedBody)).toEqual({ content: "hello", tags: ["t1"], metadata: { k: "v" } });
  });

  test("includes Authorization header when apiKey set", async () => {
    let captured: HeadersInit | undefined;
    mockFetch(async (_, init) => {
      captured = init!.headers;
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    });
    const client = new Mem9Client({ url: "http://mem9", apiKey: "secret" });
    await client.store({ content: "x", tags: [], metadata: {} });
    expect((captured as Record<string, string>)["Authorization"]).toBe("Bearer secret");
  });

  test("throws Mem9AuthError on 401", async () => {
    mockFetch(async () => new Response("", { status: 401 }));
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined });
    await expect(client.store({ content: "x", tags: [], metadata: {} })).rejects.toBeInstanceOf(Mem9AuthError);
  });

  test("throws Mem9Unavailable on network error", async () => {
    mockFetch(async () => { throw new TypeError("fetch failed"); });
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined });
    await expect(client.store({ content: "x", tags: [], metadata: {} })).rejects.toBeInstanceOf(Mem9Unavailable);
  });
});

describe("Mem9Client.get", () => {
  test("GETs /memories/:id and returns memory", async () => {
    mockFetch(async (url) => {
      expect(url).toBe("http://mem9/memories/mem-abc");
      return new Response(JSON.stringify({ id: "mem-abc", content: "hi", tags: [], metadata: {} }), { status: 200 });
    });
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined });
    const mem = await client.get("mem-abc");
    expect(mem.id).toBe("mem-abc");
    expect(mem.content).toBe("hi");
  });

  test("throws Mem9NotFound on 404", async () => {
    mockFetch(async () => new Response("", { status: 404 }));
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined });
    await expect(client.get("missing")).rejects.toBeInstanceOf(Mem9NotFound);
  });
});
