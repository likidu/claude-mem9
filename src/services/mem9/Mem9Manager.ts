import { Mem9Client } from "./Mem9Client";
import { Mem9Store } from "./Mem9Store";
import { Mem9Search } from "./Mem9Search";
import { loadMem9Config, isMem9Enabled, type Mem9Config } from "./config";
import { healthcheckMem9 } from "./healthcheck";

export class Mem9Manager {
  readonly client: Mem9Client;
  readonly store: Mem9Store;
  readonly search: Mem9Search;
  readonly config: Mem9Config;

  constructor(cfg?: Mem9Config) {
    this.config = cfg ?? loadMem9Config();
    this.client = new Mem9Client(this.config);
    this.store = new Mem9Store(this.client);
    this.search = new Mem9Search(this.client);
  }

  async healthcheck(): Promise<boolean> {
    return healthcheckMem9(this.client);
  }

  static isEnabled(): boolean {
    return isMem9Enabled();
  }
}
