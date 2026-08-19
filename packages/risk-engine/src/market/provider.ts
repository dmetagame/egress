import type { Address } from "viem";
import type {
  MarketContext,
  UserProtectionPolicy,
} from "../domain/schemas.js";

export interface MarketContextProvider {
  getContext(user: Address, policy: UserProtectionPolicy): Promise<MarketContext>;
}

export class StaticMarketContextProvider implements MarketContextProvider {
  constructor(private readonly context: MarketContext) {}

  async getContext(): Promise<MarketContext> {
    return structuredClone(this.context);
  }
}
