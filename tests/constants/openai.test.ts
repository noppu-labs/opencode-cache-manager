import { describe, expect, test } from "bun:test";
import { OPENAI_CACHE_MODEL } from "../../src/constants/openai.ts";

describe("OPENAI_CACHE_MODEL", () => {
  const negatives = ["gpt-5", "gpt-5.5", "gpt-5-mini", "gpt-4o", "gpt-4.1", "gpt-35-turbo", "azure/gpt-35-turbo", "omniroute/gpt-5.5"];
  const positives = ["gpt-5.6", "gpt-5.10", "gpt-6", "gpt-6-luna", "openai/gpt-6.1-sol", "gpt-10"];

  test.each(negatives)("%s is not matched", (id) => {
    expect(OPENAI_CACHE_MODEL.test(id)).toBe(false);
  });

  test.each(positives)("%s is matched", (id) => {
    expect(OPENAI_CACHE_MODEL.test(id)).toBe(true);
  });
});
