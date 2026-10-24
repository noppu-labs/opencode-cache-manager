import { describe, expect, test } from "bun:test";
import { profileFor } from "../../../src/services/profiles/index.ts";
import { anthropicProfile } from "../../../src/services/profiles/anthropic.ts";
import { implicitProfile } from "../../../src/services/profiles/implicit.ts";
import { openaiProfile } from "../../../src/services/profiles/openai.ts";

describe("profile registry", () => {
  test("maps every profile ID to its profile", () => {
    expect(profileFor("anthropic")).toBe(anthropicProfile);
    expect(profileFor("openai")).toBe(openaiProfile);
    expect(profileFor("implicit")).toBe(implicitProfile);
    for (const id of ["anthropic", "openai", "implicit"] as const) expect(profileFor(id).id).toBe(id);
  });
});
