import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EXTENDED_CACHE_BETA, SENTINEL_HEADER } from "../src/constants/anthropic.ts";
import { transformHttpRequest } from "../src/services/cache-ttl.ts";
import { collectCacheControls, makeRequest, parsedBodyOf, sampleBody } from "./helpers/fixtures.ts";

// ---------------------------------------------------------------------------
// opencode.jsonc -1h model variants
// ---------------------------------------------------------------------------

describe("opencode.jsonc omniroute-anthropic -1h variants", () => {
  const CONFIG_PATH = fileURLToPath(new URL("../opencode.jsonc", import.meta.url));

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

  function parseConfig(): any {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const jsonc = (globalThis as any).Bun?.JSONC;
    return typeof jsonc?.parse === "function" ? jsonc.parse(raw) : JSON.parse(stripJsonc(raw));
  }

  const EXPECTED: Record<string, string[]> = {
    "auto/claude-haiku-5-5": ["none", "low", "medium", "high", "xhigh", "max"],
    "auto/claude-sonnet-5-5": ["none", "low", "medium", "high", "xhigh", "max"],
    "auto/claude-opus-5-5": ["none", "low", "medium", "high", "xhigh", "max"],
    "auto/claude-fable-5-1": ["low", "medium", "high", "xhigh", "max"],
  };

  function models(): Record<string, any> {
    return parseConfig().providers["omniroute-anthropic"].models;
  }

  test("declares base and -1h variants for all four models", () => {
    const all = models();
    for (const [modelID, baseIds] of Object.entries(EXPECTED)) {
      const variants = all[modelID]?.variants;
      expect(Array.isArray(variants)).toBe(true);
      const ids = (variants as any[]).map((v) => v.id);
      for (const base of baseIds) {
        expect(ids).toContain(base);
        expect(ids).toContain(`${base}-1h`);
      }
    }
  });

  test("-1h variants mirror base settings and carry the 1h sentinel header", () => {
    const all = models();
    for (const [modelID, baseIds] of Object.entries(EXPECTED)) {
      const variants = all[modelID].variants as any[];
      const byId = new Map<string, any>(variants.map((v) => [v.id, v]));
      for (const base of baseIds) {
        const baseVariant = byId.get(base);
        const ttlVariant = byId.get(`${base}-1h`);
        expect(baseVariant).toBeDefined();
        expect(ttlVariant).toBeDefined();
        expect(ttlVariant!.settings).toEqual(baseVariant!.settings);
        expect(ttlVariant!.headers).toEqual({ [SENTINEL_HEADER]: "1h" });
      }
    }
  });

  test("-1h variant headers drive transformHttpRequest to 1h", async () => {
    const all = models();
    for (const modelID of Object.keys(EXPECTED)) {
      for (const variant of all[modelID].variants as any[]) {
        if (!String(variant.id).endsWith("-1h")) continue;
        const request = makeRequest(JSON.stringify(sampleBody()), variant.headers);
        const out = await transformHttpRequest(request, "5m");
        expect(out.headers.has(SENTINEL_HEADER)).toBe(false);
        expect(out.headers.get("anthropic-beta")).toBe(EXTENDED_CACHE_BETA);
        const body = (await parsedBodyOf(out)) as Record<string, unknown>;
        const controls = collectCacheControls(body);
        expect(controls.length).toBeGreaterThan(0);
        for (const cc of controls) expect(cc.ttl).toBe("1h");
      }
    }
  });
});
