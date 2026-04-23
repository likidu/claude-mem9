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
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined, backend: "public" });
    const id = await client.store({ content: "hello", tags: ["t1"], metadata: { k: "v" } });
    expect(id).toBe("mem-abc");
    expect(capturedUrl).toBe("http://mem9/memories");
    expect(JSON.parse(capturedBody)).toEqual({ content: "hello", tags: ["t1"], metadata: { k: "v" } });
  });

  test("includes X-API-Key header when apiKey set", async () => {
    let captured: HeadersInit | undefined;
    mockFetch(async (_, init) => {
      captured = init!.headers;
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    });
    const client = new Mem9Client({ url: "http://mem9", apiKey: "secret", backend: "public" });
    await client.store({ content: "x", tags: [], metadata: {} });
    expect((captured as Record<string, string>)["X-API-Key"]).toBe("secret");
  });

  test("includes Authorization: Bearer header when backend is self-hosted", async () => {
    let captured: HeadersInit | undefined;
    mockFetch(async (_, init) => {
      captured = init!.headers;
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    });
    const client = new Mem9Client({ url: "http://mem9", apiKey: "secret", backend: "self-hosted" });
    await client.store({ content: "x", tags: [], metadata: {} });
    expect((captured as Record<string, string>)["Authorization"]).toBe("Bearer secret");
    expect((captured as Record<string, string>)["X-API-Key"]).toBeUndefined();
  });

  test("public backend never sends Authorization header", async () => {
    let captured: HeadersInit | undefined;
    mockFetch(async (_, init) => {
      captured = init!.headers;
      return new Response(JSON.stringify({ status: "accepted" }), { status: 200 });
    });
    const client = new Mem9Client({ url: "http://mem9", apiKey: "secret", backend: "public" });
    await client.store({ content: "x", tags: [], metadata: {} });
    expect((captured as Record<string, string>)["Authorization"]).toBeUndefined();
    expect((captured as Record<string, string>)["X-API-Key"]).toBe("secret");
  });

  test("store() returns server id when self-hosted POST response has {id}", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ id: "mem-server-id-123" }), { status: 200 })
    );
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined, backend: "self-hosted" });
    const id = await client.store({ content: "x", tags: [], metadata: {} });
    expect(id).toBe("mem-server-id-123");
  });

  test("store() returns empty string when public POST response is {status: accepted}", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ status: "accepted" }), { status: 200 })
    );
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined, backend: "public" });
    const id = await client.store({ content: "x", tags: [], metadata: {} });
    expect(id).toBe("");
  });

  test("throws Mem9AuthError on 401", async () => {
    mockFetch(async () => new Response("", { status: 401 }));
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined, backend: "public" });
    await expect(client.store({ content: "x", tags: [], metadata: {} })).rejects.toBeInstanceOf(Mem9AuthError);
  });

  test("throws Mem9Unavailable on network error", async () => {
    mockFetch(async () => { throw new TypeError("fetch failed"); });
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined, backend: "public" });
    await expect(client.store({ content: "x", tags: [], metadata: {} })).rejects.toBeInstanceOf(Mem9Unavailable);
  });
});

describe("Mem9Client.get", () => {
  test("GETs /memories/:id and returns memory", async () => {
    mockFetch(async (url) => {
      expect(url).toBe("http://mem9/memories/mem-abc");
      return new Response(JSON.stringify({ id: "mem-abc", content: "hi", tags: [], metadata: {} }), { status: 200 });
    });
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined, backend: "public" });
    const mem = await client.get("mem-abc");
    expect(mem.id).toBe("mem-abc");
    expect(mem.content).toBe("hi");
  });

  test("throws Mem9NotFound on 404", async () => {
    mockFetch(async () => new Response("", { status: 404 }));
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined, backend: "public" });
    await expect(client.get("missing")).rejects.toBeInstanceOf(Mem9NotFound);
  });
});

describe("Mem9Client.update", () => {
  test("PUTs /memories/:id with patch body", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    mockFetch(async (url, init) => {
      capturedUrl = url;
      capturedBody = init!.body as string;
      return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
    });
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined, backend: "public" });
    await client.update("m1", { metadata: { status: "done" } });
    expect(capturedUrl).toBe("http://mem9/memories/m1");
    expect(JSON.parse(capturedBody)).toEqual({ metadata: { status: "done" } });
  });
});

describe("Mem9Client.delete", () => {
  test("DELETEs /memories/:id", async () => {
    let capturedMethod = "";
    mockFetch(async (_, init) => {
      capturedMethod = init!.method!;
      return new Response("", { status: 204 });
    });
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined, backend: "public" });
    await client.delete("m1");
    expect(capturedMethod).toBe("DELETE");
  });
});

describe("Mem9Client.search", () => {
  test("builds GET /memories with query params and returns results", async () => {
    let capturedUrl = "";
    mockFetch(async (url) => {
      capturedUrl = url;
      return new Response(JSON.stringify({
        memories: [{ id: "m1", content: "x", tags: [], metadata: {} }],
      }), { status: 200 });
    });
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined, backend: "public" });
    const out = await client.search({
      query: "hello",
      tags: ["kind:observation", "project:demo"],
      limit: 10,
    });
    expect(out.length).toBe(1);
    expect(capturedUrl).toContain("query=hello");
    expect(capturedUrl).toContain("tags=kind%3Aobservation%2Cproject%3Ademo");
    expect(capturedUrl).toContain("limit=10");
  });

  test("search() parses {memories: [...]} for public backend", async () => {
    const publicFixture = await import("./fixtures/public-api-responses.json");
    mockFetch(async () =>
      new Response(JSON.stringify(publicFixture.default.GET_memories_response), { status: 200 })
    );
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined, backend: "public" });
    const out = await client.search({ limit: 10 });
    expect(out.length).toBe(1);
    expect(out[0].id).toBe("e08338ea-2274-4109-90fc-3f4c49e3072f");
  });

  test("search() parses {results: [...]} for self-hosted backend", async () => {
    const selfHostedFixture = await import("./fixtures/self-hosted-responses.json");
    mockFetch(async () =>
      new Response(JSON.stringify(selfHostedFixture.default.GET_memories_response), { status: 200 })
    );
    const client = new Mem9Client({ url: "http://mem9", apiKey: undefined, backend: "self-hosted" });
    const out = await client.search({ limit: 10 });
    expect(out.length).toBe(1);
    expect(out[0].id).toBe("mem-uuid-1234-5678-9abc-def012345678");
  });
});
