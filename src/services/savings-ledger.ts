import type { CacheUsage, ModelRef, Ttl } from '../models/cache.ts';
import type { LedgerTotals, ModelPrice, SavingsReadout } from '../models/savings.ts';
import type { LedgerStore } from './ledger-store.ts';
import type { PriceBook } from './model-prices.ts';
import { avoidedUnits, avoidedUsd, pingUnits, pingUsd, toReadout } from './savings-math.ts';
import { contextTokens } from './usage.ts';

/** The model an event is priced for; `reportedModel` is what the response named. */
interface PricedModel {
  ref: ModelRef;
  reportedModel?: string;
}

interface SavingsLedgerDeps {
  prices: Pick<PriceBook, 'lookup'>;
  store: Pick<LedgerStore, 'peek' | 'load' | 'update'>;
  /** Called after any readout change, including a finished load. */
  onChange: (sessionID: string) => void;
}

/**
 * Turns keepalive events into per-session savings totals. Events of one session are
 * applied strictly in call order (each waits for the previous one's price lookup),
 * so a ping called before `stretchStarted` counts toward the old stretch.
 */
class SavingsLedger {
  private readonly stretchUsd = new Map<string, number>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly loading = new Set<string>();

  public constructor(private readonly deps: SavingsLedgerDeps) {}

  /**
   * A real request ended the stretch: resets the stretch ping cost. The reset is applied
   * in event order, asynchronously, so `readout` right after may still show the old
   * stretch cost until earlier events settle.
   */
  public stretchStarted(sessionID: string): void {
    void this.enqueue(sessionID, () => {
      this.stretchUsd.delete(sessionID);
    });
  }

  public async pingCharged(
    sessionID: string,
    model: PricedModel,
    usage: CacheUsage,
    ttl: Ttl
  ): Promise<void> {
    await this.enqueue(sessionID, async () => {
      const price = await this.lookupPrice(model, contextTokens(usage));
      const usd = price === undefined ? 0 : pingUsd(usage, ttl, price);
      await this.deps.store.update(sessionID, (totals) => ({
        ...totals,
        pingUnits: totals.pingUnits + pingUnits(usage, ttl),
        pingUsd: totals.pingUsd + usd,
        pings: totals.pings + 1,
        unpricedEvents: totals.unpricedEvents + (price === undefined ? 1 : 0),
      }));
      if (price !== undefined) {
        this.stretchUsd.set(sessionID, (this.stretchUsd.get(sessionID) ?? 0) + usd);
      }
    });
  }

  /** `returnContextTokens` is the return response's own context size, which picks the price tier. */
  public async stretchRescued(
    sessionID: string,
    model: PricedModel,
    avoidedTokens: number,
    ttl: Ttl,
    returnContextTokens: number
  ): Promise<void> {
    await this.enqueue(sessionID, async () => {
      const price = await this.lookupPrice(model, returnContextTokens);
      const usd = price === undefined ? 0 : avoidedUsd(avoidedTokens, ttl, price);
      await this.deps.store.update(sessionID, (totals): LedgerTotals => ({
        ...totals,
        avoidedTokens: totals.avoidedTokens + avoidedTokens,
        avoidedUnits: totals.avoidedUnits + avoidedUnits(avoidedTokens, ttl),
        avoidedUsd: totals.avoidedUsd + usd,
        rescues: totals.rescues + 1,
        unpricedEvents: totals.unpricedEvents + (price === undefined ? 1 : 0),
      }));
    });
  }

  /** Synchronous; null before the session's totals are loaded (starts the load). */
  public readout(sessionID: string): SavingsReadout | null {
    const totals = this.deps.store.peek(sessionID);
    if (totals === undefined) {
      this.startLoad(sessionID);
      return null;
    }
    return toReadout(totals, this.stretchUsd.get(sessionID) ?? null);
  }

  /** A rejected lookup counts as unpriced. */
  private async lookupPrice(model: PricedModel, tokens: number): Promise<ModelPrice | undefined> {
    let price: ModelPrice | undefined;
    try {
      price = await this.deps.prices.lookup(model.ref, tokens, model.reportedModel);
    } catch {
      // Left unpriced.
    }
    return price;
  }

  private startLoad(sessionID: string): void {
    if (this.loading.has(sessionID)) return;
    this.loading.add(sessionID);
    void this.deps.store
      .load(sessionID)
      .catch(() => {})
      .then(() => {
        this.loading.delete(sessionID);
        this.notify(sessionID);
      });
  }

  /** Runs `step` after the session's earlier events, then notifies. Never rejects. */
  private async enqueue(sessionID: string, step: () => Promise<void> | void): Promise<void> {
    const run = (this.chains.get(sessionID) ?? Promise.resolve()).then(async () => {
      try {
        await step();
      } catch {
        // A failed event is dropped; the chain must keep moving.
      }
      this.notify(sessionID);
    });
    this.chains.set(sessionID, run);
    await run;
  }

  private notify(sessionID: string): void {
    try {
      this.deps.onChange(sessionID);
    } catch {
      // A failing listener must not break the ledger.
    }
  }
}

export type { PricedModel, SavingsLedgerDeps };
export { SavingsLedger };
