import { describe, expect, test } from "bun:test";
import { PROFILES, profileFor } from "../../../src/services/profiles/index.ts";

describe("profile registry", () => {
  test("maps every profile ID to its profile", () => {
    for (const id of ["anthropic", "openai", "implicit"] as const) {
      expect(profileFor(id)).toBe(PROFILES[id]);
      expect(profileFor(id).id).toBe(id);
    }
  });
});
