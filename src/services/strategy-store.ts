import { ANTHROPIC_UPSTREAM, EXPLICIT_CACHE_MODEL } from "../constants/openai.ts";
import type { CacheStrategy, ModelRef } from "../models/cache.ts";
import { isRecord } from "../utils/is-record.ts";
import type { KV } from "./settings-store.ts";

const STORAGE_KEY = "learned-models";
const key = (ref: ModelRef) => `${ref.providerID}/${ref.id}`;

/** Cache strategies learned from the resolved `model` / `provider` of past responses, persisted in plugin storage. */
export class StrategyStore {
  private learned = new Map<string, CacheStrategy>();

  constructor(private readonly kv: KV) {}

  async load(): Promise<void> {
    this.learned = new Map();
    let stored: unknown;
    try {
      stored = await this.kv.get(STORAGE_KEY);
    } catch {
      return;
    }
    if (!isRecord(stored)) return;
    for (const [name, strategy] of Object.entries(stored)) {
      if (strategy === "explicit" || strategy === "implicit") this.learned.set(name, strategy);
    }
  }

  get(ref: ModelRef): CacheStrategy | undefined {
    return this.learned.get(key(ref));
  }

  /** Records the strategy a response reveals; the latest response wins. Never rejects, so callers can fire and forget. */
  async learnFromResponse(
    ref: ModelRef,
    identity: { model?: string; provider?: string } | undefined,
  ): Promise<void> {
    try {
      const { model, provider } = identity ?? {};
      if (!model && !provider) return;
      const strategy: CacheStrategy =
        (model !== undefined && EXPLICIT_CACHE_MODEL.test(model)) ||
        (provider !== undefined && ANTHROPIC_UPSTREAM.test(provider))
          ? "explicit"
          : "implicit";
      if (this.learned.get(key(ref)) === strategy) return;
      this.learned.set(key(ref), strategy);
      await this.kv.set(STORAGE_KEY, Object.fromEntries(this.learned));
    } catch {
      // The in-memory value stays; only persistence is lost.
    }
  }
}
