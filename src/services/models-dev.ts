import {
  MODELS_DEV_MAX_AGE_MS,
  MODELS_DEV_RETRY_MS,
  MODELS_DEV_STORAGE_KEY,
  MODELS_DEV_URL,
  MODELS_DEV_VENDORS,
} from '../constants/savings.ts';
import type { ModelPrice } from '../models/savings.ts';
import type { KV } from '../models/storage.ts';
import { isRecord } from '../utils/is-record.ts';

interface ModelsDevDeps {
  kv: KV;
  fetchJson: (url: string) => Promise<unknown>;
  now: () => number;
}

interface Listing {
  provider: string;
  price: ModelPrice;
}

interface Cache {
  fetchedAt: number;
  body: unknown;
}

const DATE_SUFFIX = /-\d{8}$/u;
const LATEST_SUFFIX = /-latest$/u;

/** Lowercased name without a `provider/` prefix, a `-YYYYMMDD` suffix or `-latest`. */
function normaliseModelName(name: string): string {
  let result = name.trim().toLowerCase();
  const slash = result.indexOf('/');
  if (slash !== -1) {
    result = result.slice(slash + 1);
  }
  return result.replace(LATEST_SUFFIX, '').replace(DATE_SUFFIX, '');
}

function priceField(value: unknown): number | undefined {
  if (value === undefined) {
    return 0;
  }
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A usable price: input > 0, every other present field finite >= 0 (absent cache prices are 0). */
function toPrice(cost: unknown): ModelPrice | undefined {
  if (!isRecord(cost)) {
    return undefined;
  }
  const input = priceField(cost.input);
  const output = priceField(cost.output);
  const cacheRead = priceField(cost.cache_read);
  const cacheWrite = priceField(cost.cache_write);
  if (
    input === undefined ||
    input <= 0 ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined
  ) {
    return undefined;
  }
  return { cacheRead, cacheWrite, input, output };
}

function buildIndex(body: unknown): Map<string, Listing[]> {
  const index = new Map<string, Listing[]>();
  if (!isRecord(body)) {
    return index;
  }
  for (const [provider, entry] of Object.entries(body)) {
    if (!isRecord(entry) || !isRecord(entry.models)) {
      continue;
    }
    for (const [key, model] of Object.entries(entry.models)) {
      const price = isRecord(model) ? toPrice(model.cost) : undefined;
      if (price === undefined) {
        continue;
      }
      const name = normaliseModelName(key);
      const listings = index.get(name) ?? [];
      listings.push({ price, provider: provider.toLowerCase() });
      index.set(name, listings);
    }
  }
  return index;
}

const samePrice = (left: ModelPrice, right: ModelPrice): boolean =>
  left.input === right.input &&
  left.output === right.output &&
  left.cacheRead === right.cacheRead &&
  left.cacheWrite === right.cacheWrite;

function pick(listings: readonly Listing[]): ModelPrice | undefined {
  for (const vendor of MODELS_DEV_VENDORS) {
    const own = listings.find((listing) => listing.provider === vendor);
    if (own !== undefined) {
      return own.price;
    }
  }
  const [first] = listings;
  return first !== undefined && listings.every((listing) => samePrice(listing.price, first.price))
    ? first.price
    : undefined;
}

function toCache(value: unknown): Cache | undefined {
  if (!isRecord(value) || typeof value.fetchedAt !== 'number' || !isRecord(value.body)) {
    return undefined;
  }
  return { body: value.body, fetchedAt: value.fetchedAt };
}

/** Opt-in price fallback from models.dev: one cached fetch, refreshed at most once a day. */
class ModelsDevPrices {
  private cache: Cache | undefined;
  private index: Map<string, Listing[]> | undefined;
  private loaded = false;
  private failedAt: number | undefined;
  private inflight: Promise<void> | undefined;

  public constructor(private readonly deps: ModelsDevDeps) {}

  /** First name with exactly one clear match wins; never rejects. */
  public async match(names: readonly string[]): Promise<ModelPrice | undefined> {
    try {
      await this.refresh();
      const index = this.getIndex();
      for (const name of names) {
        const listings = index.get(normaliseModelName(name));
        const price = listings === undefined ? undefined : pick(listings);
        if (price !== undefined) {
          return price;
        }
      }
    } catch {
      // Treat any failure as no data.
    }
    return undefined;
  }

  private getIndex(): Map<string, Listing[]> {
    this.index ??= buildIndex(this.cache?.body);
    return this.index;
  }

  private async refresh(): Promise<void> {
    if (!this.loaded) {
      this.loaded = true;
      this.cache = toCache(await this.deps.kv.get(MODELS_DEV_STORAGE_KEY).catch(() => null));
    }
    const now = this.deps.now();
    if (this.cache !== undefined && now - this.cache.fetchedAt < MODELS_DEV_MAX_AGE_MS) {
      return;
    }
    if (this.failedAt !== undefined && now - this.failedAt < MODELS_DEV_RETRY_MS) {
      return;
    }
    this.inflight ??= this.fetchFresh().finally(() => {
      this.inflight = undefined;
    });
    await this.inflight;
  }

  private async fetchFresh(): Promise<void> {
    try {
      const body = await this.deps.fetchJson(MODELS_DEV_URL);
      if (!isRecord(body)) {
        throw new TypeError('models.dev body is not an object');
      }
      this.cache = { body, fetchedAt: this.deps.now() };
      this.index = undefined;
      this.failedAt = undefined;
      await this.deps.kv.set(MODELS_DEV_STORAGE_KEY, this.cache).catch(() => null);
    } catch {
      this.failedAt = this.deps.now();
    }
  }
}

export { ModelsDevPrices, normaliseModelName };
export type { ModelsDevDeps };
