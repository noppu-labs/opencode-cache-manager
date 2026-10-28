import type { CacheProfileId } from '../../models/cache.ts';
import type { CacheProfile } from '../../models/profile.ts';
import { anthropicProfile } from './anthropic.ts';
import { implicitProfile } from './implicit.ts';
import { openaiProfile } from './openai.ts';

/** Every cache profile by ID. */
const PROFILES: Record<CacheProfileId, CacheProfile> = {
  anthropic: anthropicProfile,
  implicit: implicitProfile,
  openai: openaiProfile,
};

/** The profile for an ID. */
export function profileFor(id: CacheProfileId): CacheProfile {
  return PROFILES[id];
}
