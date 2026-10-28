import { describe, expect, test } from 'bun:test';

import { parseCacheProfiles } from '../../src/config/model-patterns.ts';

describe('parseCacheProfiles', () => {
  test('keeps the profile of each entry in order', () => {
    const patterns = parseCacheProfiles({
      'gpt-6': 'openai',
      'opus': 'anthropic',
      'gpt-4': 'implicit',
    });
    expect(patterns.map((p) => p.profile)).toEqual(['openai', 'anthropic', 'implicit']);
  });

  test('drops an invalid regex', () => {
    expect(parseCacheProfiles({ '/(/': 'anthropic', 'opus': 'anthropic' })).toHaveLength(1);
  });

  test('an invalid regex body with valid flags is still dropped', () => {
    expect(parseCacheProfiles({ '/(/i': 'anthropic', '/[/': 'openai' })).toEqual([]);
  });

  test('drops empty patterns and invalid profile values', () => {
    const patterns = parseCacheProfiles({
      '': 'anthropic',
      'a': 'explicit',
      'b': 1,
      'c': null,
      'd': 'OPENAI',
      'opus': 'anthropic',
    });
    expect(patterns).toHaveLength(1);
    expect(patterns[0].profile).toBe('anthropic');
  });

  test('a leading ! is part of the pattern, not a negation', () => {
    const [pattern] = parseCacheProfiles({ '!opus': 'anthropic' });
    expect(pattern.matches({ providerID: 'omniroute', id: '!opus' })).toBe(true);
    expect(pattern.matches({ providerID: 'omniroute', id: 'opus' })).toBe(false);
  });

  test('a missing, array or non-record option gives []', () => {
    expect(parseCacheProfiles(undefined)).toEqual([]);
    expect(parseCacheProfiles('opus')).toEqual([]);
    expect(parseCacheProfiles(['opus'])).toEqual([]);
    expect(parseCacheProfiles(null)).toEqual([]);
  });
});
