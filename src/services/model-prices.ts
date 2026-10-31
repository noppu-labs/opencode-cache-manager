import type { ModelRef } from '../models/cache';
import type { ModelPrice } from '../models/savings';

interface CatalogCost {
  tier?: { type: 'context'; size: number };
  input: number;
  output: number;
  cache: { read: number; write: number };
}

interface CatalogModel {
  id: string;
  providerID: string;
  cost: readonly CatalogCost[];
}

interface PriceBookDeps {
  listModels: () => Promise<readonly CatalogModel[]>;
  /** Opt-in models.dev fallback; undefined when modelsDevPrices is off. */
  fallback?: (names: readonly string[]) => Promise<ModelPrice | undefined>;
}

/** The tier whose size is the largest at or below `contextTokens`, else the untiered entry, else the smallest tier. */
function selectTier(costs: readonly CatalogCost[], contextTokens: number): CatalogCost | undefined {
  let best: CatalogCost | undefined;
  let untiered: CatalogCost | undefined;
  let smallest: CatalogCost | undefined;
  for (const entry of costs) {
    if (entry.tier === undefined) {
      untiered ??= entry;
      continue;
    }
    const { size } = entry.tier;
    if (size <= contextTokens && (best?.tier === undefined || size > best.tier.size)) {
      best = entry;
    }
    if (smallest?.tier === undefined || size < smallest.tier.size) {
      smallest = entry;
    }
  }
  return best ?? untiered ?? smallest;
}

function isPriceNumber(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/** A usable price: every field a finite number >= 0 and a non-zero input. */
function toPrice(entry: CatalogCost | undefined): ModelPrice | undefined {
  if (entry === undefined) {
    return undefined;
  }
  const price: ModelPrice = {
    cacheRead: entry.cache.read,
    cacheWrite: entry.cache.write,
    input: entry.input,
    output: entry.output,
  };
  const valid = [price.cacheRead, price.cacheWrite, price.input, price.output].every((value) =>
    isPriceNumber(value)
  );
  return valid && price.input > 0 ? price : undefined;
}

function fallbackNames(id: string, reportedModel: string | undefined): string[] {
  const names = [reportedModel, id].filter(
    (name): name is string => name !== undefined && name !== ''
  );
  return [...new Set(names)];
}

const refKey = (ref: ModelRef): string => `${ref.providerID}\u0000${ref.id}`;

/**
 * Per-million-token prices from OpenCode's model catalog, with an optional injected fallback.
 * The catalog is cached; a model missing from it triggers at most one reload per distinct model.
 */
class PriceBook {
  private catalog: readonly CatalogModel[] | undefined;
  private inflight: Promise<readonly CatalogModel[] | undefined> | undefined;
  private readonly reloaded = new Set<string>();

  public constructor(private readonly deps: PriceBookDeps) {}

  /** Warms the catalog; never rejects. */
  public async prefetch(): Promise<void> {
    await this.load();
  }

  /** The price for `ref` at `contextTokens`, or undefined when unpriced. Never rejects. */
  public async lookup(
    ref: ModelRef,
    contextTokens: number,
    reportedModel?: string
  ): Promise<ModelPrice | undefined> {
    const entry = await this.findEntry(ref);
    if (entry !== undefined) {
      const price = toPrice(selectTier(entry.cost, contextTokens));
      if (price !== undefined) {
        return price;
      }
    }
    return this.askFallback(fallbackNames(ref.id, reportedModel));
  }

  private async findEntry(ref: ModelRef): Promise<CatalogModel | undefined> {
    const match = (list: readonly CatalogModel[] | undefined): CatalogModel | undefined =>
      list?.find((model) => model.providerID === ref.providerID && model.id === ref.id);
    const cached = this.catalog ?? (await this.load());
    const found = match(cached);
    const key = refKey(ref);
    // A failed first load is retried by the next lookup, not twice in this one.
    if (cached === undefined || found !== undefined || this.reloaded.has(key)) {
      return found;
    }
    this.reloaded.add(key);
    return match(await this.load(true));
  }

  /** Loads the catalog once at a time; keeps the previous one if a reload fails. */
  private async load(force = false): Promise<readonly CatalogModel[] | undefined> {
    if (!force && this.catalog !== undefined) {
      return this.catalog;
    }
    this.inflight ??= this.fetchCatalog().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetchCatalog(): Promise<readonly CatalogModel[] | undefined> {
    try {
      this.catalog = await this.deps.listModels();
    } catch {
      // Leave any previous catalog in place; the next lookup retries.
    }
    return this.catalog;
  }

  private async askFallback(names: readonly string[]): Promise<ModelPrice | undefined> {
    if (this.deps.fallback === undefined) {
      return undefined;
    }
    try {
      return await this.deps.fallback(names);
    } catch {
      return undefined;
    }
  }
}

export type { CatalogCost, CatalogModel, PriceBookDeps };
export { PriceBook, selectTier };
