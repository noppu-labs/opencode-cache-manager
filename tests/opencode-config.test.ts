import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EXTENDED_CACHE_BETA, SENTINEL_HEADER } from "../src/constants/anthropic.ts";
import { transformHttpRequest } from "../src/services/cache-ttl.ts";
import { collectCacheControls, makeRequest, parsedBodyOf, sampleBody } from "./helpers/fixtures.ts";

// ---------------------------------------------------------------------------
// docs/examples/*.jsonc: every example parses and every -1h variant rewrites to 1h
// ---------------------------------------------------------------------------

const EXAMPLES_DIR = fileURLToPath(new URL("../docs/examples/", import.meta.url));

/** Strips single-line `//` comments (outside strings) and trailing commas from JSONC. */
function stripJsonc(raw: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function parseExample(file: string): any {
  const raw = readFileSync(`${EXAMPLES_DIR}${file}`, "utf8");
  const jsonc = (globalThis as any).Bun?.JSONC;
  return typeof jsonc?.parse === "function" ? jsonc.parse(raw) : JSON.parse(stripJsonc(raw));
}

const EXAMPLE_FILES = readdirSync(EXAMPLES_DIR)
  .filter((f) => f.endsWith(".jsonc"))
  .sort();

interface ExampleVariant {
  id: string;
  settings?: unknown;
  headers?: Record<string, string>;
}

/** Every (provider, model, variant) in an example config, with the base variant of each `-1h` one. */
function oneHourVariants(config: any): { label: string; variant: ExampleVariant; base: ExampleVariant | undefined }[] {
  const out: { label: string; variant: ExampleVariant; base: ExampleVariant | undefined }[] = [];
  for (const [providerID, provider] of Object.entries<any>(config.providers ?? {})) {
    for (const [modelID, model] of Object.entries<any>(provider.models ?? {})) {
      const variants: ExampleVariant[] = model.variants ?? [];
      for (const variant of variants) {
        if (!variant.id.endsWith("-1h")) continue;
        out.push({
          label: `${providerID}/${modelID}/${variant.id}`,
          variant,
          base: variants.find((v) => v.id === variant.id.slice(0, -"-1h".length)),
        });
      }
    }
  }
  return out;
}

function openAiChatRequest(url: string, headers: Record<string, string>): Request {
  const body = {
    model: "anthropic/claude-sonnet-5.5",
    stream: true,
    messages: [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "Say hello." },
    ],
    tools: [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object" } } }],
  };
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("docs/examples", () => {
  test("has an example per supported endpoint", () => {
    expect(EXAMPLE_FILES).toEqual([
      "opencode.anthropic.jsonc",
      "opencode.openai-compatible.jsonc",
      "opencode.openrouter.jsonc",
    ]);
  });

  describe.each(EXAMPLE_FILES)("%s", (file) => {
    const config = parseExample(file);
    const variants = oneHourVariants(config);
    const openai = file !== "opencode.anthropic.jsonc";

    test("parses and declares providers with models", () => {
      expect(config.$schema).toBe("https://opencode.ai/config.json");
      const providers = Object.values<any>(config.providers);
      expect(providers.length).toBeGreaterThan(0);
      for (const provider of providers) expect(Object.keys(provider.models).length).toBeGreaterThan(0);
    });

    test("has -1h variants", () => {
      expect(variants.length).toBeGreaterThan(0);
    });

    test("-1h variants mirror their base variant and carry the 1h sentinel header", () => {
      for (const { label, variant, base } of variants) {
        expect(base, label).toBeDefined();
        expect(variant.settings, label).toEqual(base!.settings);
        expect(variant.headers, label).toEqual({ [SENTINEL_HEADER]: "1h" });
      }
    });

    test("every -1h variant rewrites its request to 1h", async () => {
      for (const { label, variant } of variants) {
        const request = openai
          ? openAiChatRequest("https://your-proxy.example/v1/chat/completions", variant.headers ?? {})
          : makeRequest(JSON.stringify(sampleBody()), variant.headers);
        const out = await transformHttpRequest(
          request,
          "5m",
          openai ? { wire: "openai-chat", inject: true } : {},
        );
        expect(out.headers.has(SENTINEL_HEADER), label).toBe(false);
        expect(out.headers.get("anthropic-beta"), label).toBe(EXTENDED_CACHE_BETA);
        const controls = collectCacheControls(await parsedBodyOf(out));
        expect(controls.length, label).toBeGreaterThan(0);
        for (const cc of controls) expect(cc.ttl, label).toBe("1h");
      }
    });

    test("holds no secrets or personal hostnames", () => {
      const raw = readFileSync(`${EXAMPLES_DIR}${file}`, "utf8");
      expect(raw).not.toMatch(/linksy/i);
      for (const match of raw.matchAll(/"(?:apiKey|authToken)":\s*"([^"]*)"/g)) {
        expect(match[1]).toMatch(/^\{env:[A-Z_]+\}$/);
      }
    });
  });

  test("the Anthropic example declares base and -1h variants for all four models", () => {
    const EXPECTED: Record<string, string[]> = {
      "auto/claude-haiku-5-5": ["none", "low", "medium", "high", "xhigh", "max"],
      "auto/claude-sonnet-5-5": ["none", "low", "medium", "high", "xhigh", "max"],
      "auto/claude-opus-5-5": ["none", "low", "medium", "high", "xhigh", "max"],
      "auto/claude-fable-5-1": ["low", "medium", "high", "xhigh", "max"],
    };
    const models = parseExample("opencode.anthropic.jsonc").providers["omniroute-anthropic"].models;
    for (const [modelID, baseIds] of Object.entries(EXPECTED)) {
      const ids = (models[modelID]?.variants as ExampleVariant[]).map((v) => v.id);
      for (const base of baseIds) {
        expect(ids).toContain(base);
        expect(ids).toContain(`${base}-1h`);
      }
    }
  });

  test("the OpenAI-wire examples use the expected provider packages", () => {
    const openrouter = parseExample("opencode.openrouter.jsonc").providers.openrouter;
    expect(openrouter.package).toBe("@opencode/ai/providers/openrouter");
    const generic = Object.values<any>(parseExample("opencode.openai-compatible.jsonc").providers)[0];
    expect(generic.package).toBe("@opencode/ai/providers/openai-compatible");
    expect(generic.settings.baseURL).toBe("https://your-proxy.example/v1");
  });
});
