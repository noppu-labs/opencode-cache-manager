import { ANTHROPIC_UPSTREAM, CLAUDE_MODEL, OPENAI_CACHE_MODEL } from "../constants/openai.ts";
import { isCacheProfileId, type CacheProfileId, type ModelRef, type ResponseIdentity } from "../models/cache.ts";
import type { KV } from "../models/storage.ts";
import { isRecord } from "../utils/is-record.ts";

const STORAGE_KEY = "learned-models";
const key = (ref: ModelRef) => `${ref.providerID}/${ref.id}`;

/** Cache profiles learned from the resolved `model` / `provider` of past responses, persisted in plugin storage. */
export class ProfileStore {
  private learned = new Map<string, CacheProfileId>();

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
    for (const [name, profile] of Object.entries(stored)) {
      if (profile === "explicit") this.learned.set(name, "anthropic");
      else if (isCacheProfileId(profile)) this.learned.set(name, profile);
    }
  }

  get(ref: ModelRef): CacheProfileId | undefined {
    return this.learned.get(key(ref));
  }

  /**
   * Records the profile a response reveals; the latest response wins. Never rejects, so callers can fire and forget.
   * A learned `openai` never widens classification (see `classifyRequest`), but storing it still replaces a stale
   * `anthropic` entry for an alias that a router now answers with GPT.
   */
  async learnFromResponse(
    ref: ModelRef,
    identity: ResponseIdentity | undefined,
  ): Promise<void> {
    try {
      const { model, provider } = identity ?? {};
      if (!model && !provider) return;
      const profile: CacheProfileId =
        (model !== undefined && CLAUDE_MODEL.test(model)) ||
        (provider !== undefined && ANTHROPIC_UPSTREAM.test(provider))
          ? "anthropic"
          : model !== undefined && OPENAI_CACHE_MODEL.test(model)
            ? "openai"
            : "implicit";
      if (this.learned.get(key(ref)) === profile) return;
      this.learned.set(key(ref), profile);
      await this.kv.set(STORAGE_KEY, Object.fromEntries(this.learned));
    } catch {
      // The in-memory value stays; only persistence is lost.
    }
  }
}
