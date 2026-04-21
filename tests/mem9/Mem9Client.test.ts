import { describe, test, expect } from "bun:test";
import { Mem9Client } from "../../src/services/mem9/Mem9Client";
import { Mem9Unavailable, Mem9AuthError, Mem9NotFound } from "../../src/services/mem9/errors";

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = impl as any;
  return () => { globalThis.fetch = original; };
}

describe("Mem9Client.store", () => {
  test("POSTs to /memories with content/tags/metadata and returns id", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    const restore = mockFetch(async (url, init) => {
      capturedUrl = url;
      capturedBody = init!.body as string;
      return new Response(JSON.stringify({ id: "mem-abc" }), { status: 200 });
    });
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined });
    const id = await client.store({ content: "hello", tags: ["t1"], metadata: { k: "v" } });
    restore();
    expect(id).toBe("mem-abc");
    expect(capturedUrl).toBe("http://mem9/memories");
    expect(JSON.parse(capturedBody)).toEqual({ content: "hello", tags: ["t1"], metadata: { k: "v" } });
  });

  test("includes Authorization header when apiKey set", async () => {
    let captured: HeadersInit | undefined;
    const restore = mockFetch(async (_, init) => {
      captured = init!.headers;
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    });
    const client = new Mem9Client({ url: "http://mem9", apiKey: "secret" });
    await client.store({ content: "x", tags: [], metadata: {} });
    restore();
    expect((captured as Record<string, string>)["Authorization"]).toBe("Bearer secret");
  });

  test("throws Mem9AuthError on 401", async () => {
    const restore = mockFetch(async () => new Response("", { status: 401 }));
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined });
    restore;
    await expect(client.store({ content: "x", tags: [], metadata: {} })).rejects.toBeInstanceOf(Mem9AuthError);
    restore();
  });

  test("throws Mem9Unavailable on network error", async () => {
    const restore = mockFetch(async () => { throw new TypeError("fetch failed"); });
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined });
    await expect(client.store({ content: "x", tags: [], metadata: {} })).rejects.toBeInstanceOf(Mem9Unavailable);
    restore();
  });
});

describe("Mem9Client.get", () => {
  test("GETs /memories/:id and returns memory", async () => {
    const restore = mockFetch(async (url) => {
      expect(url).toBe("http://mem9/memories/mem-abc");
      return new Response(JSON.stringify({ id: "mem-abc", content: "hi", tags: [], metadata: {} }), { status: 200 });
    });
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined });
    const mem = await client.get("mem-abc");
    restore();
    expect(mem.id).toBe("mem-abc");
    expect(mem.content).toBe("hi");
  });

  test("throws Mem9NotFound on 404", async () => {
    const restore = mockFetch(async () => new Response("", { status: 404 }));
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined });
    await expect(client.get("missing")).rejects.toBeInstanceOf(Mem9NotFound);
    restore();
  });
});
