import type { ModelRef } from '../models/cache';
import type { ModelPrice } from '../models/savings';
import { isRecord } from '../utils/is-record.ts';

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

function toCatalogCost(value: unknown): CatalogCost | undefined {
  if (!isRecord(value) || !isRecord(value.cache)) {
    return undefined;
  }
  const { cache, input, output, tier } = value;
  const { read, write } = cache;
  if (
    typeof input !== 'number' ||
    typeof output !== 'number' ||
    typeof read !== 'number' ||
    typeof write !== 'number'
  ) {
    return undefined;
  }
  const entry: CatalogCost = { cache: { read, write }, input, output };
  if (tier === undefined) {
    return entry;
  }
  if (!isRecord(tier) || tier.type !== 'context' || typeof tier.size !== 'number') {
    return undefined;
  }
  return { ...entry, tier: { size: tier.size, type: 'context' } };
}

/** The catalog part of `ctx.model.list()` data; models and cost entries of another shape are skipped. */
function toCatalogModels(data: unknown): CatalogModel[] {
  if (!Array.isArray(data)) {
    return [];
  }
  const models: CatalogModel[] = [];
  for (const info of data) {
    if (
      !isRecord(info) ||
      typeof info.id !== 'string' ||
      typeof info.providerID !== 'string' ||
      !Array.isArray(info.cost)
    ) {
      continue;
    }
    const cost = info.cost
      .map((entry) => toCatalogCost(entry))
      .filter((entry): entry is CatalogCost => entry !== undefined);
    models.push({ cost, id: info.id, providerID: info.providerID });
  }
  return models;
}

const refKey = (ref: ModelRef): string => `${ref.providerID}\u0000${ref.id}`;

/**
 * Per-million-token prices from OpenCode's model catalog, with an optional injected fallback.
 * The catalog is cached; a model missing from it triggers at most one reload per distinct model.
 */
class PriceBook {
  private catalog: readonly CatalogModel[] | undefined;
  private inflight: Promise<readonly CatalogModel[] | undefined> | undefined;
  private readonly reloads = new Map<string, Promise<CatalogModel | undefined>>();

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
    const found = await this.findEntry(ref);
    // Without a catalog we cannot tell whether the user declared a cost, so models.dev must not stand in.
    if (found === undefined) {
      return undefined;
    }
    if (found.entry !== undefined) {
      const price = toPrice(selectTier(found.entry.cost, contextTokens));
      if (price !== undefined) {
        return price;
      }
    }
    return this.askFallback(fallbackNames(ref.id, reportedModel));
  }

  /** Undefined when no catalog could be loaded; otherwise the matching entry, if any. */
  private async findEntry(ref: ModelRef): Promise<{ entry?: CatalogModel } | undefined> {
    const match = (list: readonly CatalogModel[] | undefined): CatalogModel | undefined =>
      list?.find((model) => model.providerID === ref.providerID && model.id === ref.id);
    const cached = this.catalog ?? (await this.load());
    if (cached === undefined) {
      return undefined;
    }
    const entry = match(cached);
    if (entry !== undefined) {
      return { entry };
    }
    const key = refKey(ref);
    let reload = this.reloads.get(key);
    if (reload === undefined) {
      reload = this.load(true).then((list) => match(list));
      this.reloads.set(key, reload);
    }
    return { entry: await reload };
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
export { PriceBook, selectTier, toCatalogModels };
