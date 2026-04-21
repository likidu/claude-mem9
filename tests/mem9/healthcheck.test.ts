import { describe, test, expect } from "bun:test";
import { healthcheckMem9 } from "../../src/services/mem9/healthcheck";
import { Mem9Client } from "../../src/services/mem9/Mem9Client";
import { Mem9Unavailable } from "../../src/services/mem9/errors";

function fakeClient(impl: Partial<Mem9Client>): Mem9Client {
  return impl as Mem9Client;
}

describe("healthcheckMem9", () => {
  test("returns true when search succeeds", async () => {
    const client = fakeClient({ search: async () => [] });
    expect(await healthcheckMem9(client)).toBe(true);
  });

  test("rethrows Mem9Unavailable so caller can fail fast", async () => {
    const client = fakeClient({
      search: async () => { throw new Mem9Unavailable("http://mem9"); },
    });
    await expect(healthcheckMem9(client)).rejects.toBeInstanceOf(Mem9Unavailable);
  });
});
