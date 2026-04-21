import { Mem9Client } from "./Mem9Client";

export async function healthcheckMem9(client: Mem9Client): Promise<boolean> {
  // minimal probe: a search with limit=1 hits the server without requiring known data
  await client.search({ limit: 1 });
  return true;
}
