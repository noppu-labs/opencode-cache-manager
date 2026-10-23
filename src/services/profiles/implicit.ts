import type { CacheProfile } from "../../models/profile.ts";

/** Provider-managed caching: nothing to rewrite, nothing to keep warm. */
export const implicitProfile: CacheProfile = {
  id: "implicit",
  wires: ["openai-chat", "openai-responses"],
  ttlForMode: () => null,
  rewrite: () => false,
  pings: false,
};
