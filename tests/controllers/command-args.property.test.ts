import { describe, expect, test } from 'bun:test';

import fc from 'fast-check';

import { MAX_PINGS_LIMIT, sanitizePatch } from '../../src/config/settings.ts';
import { parseCommandArg } from '../../src/controllers/command-args.ts';
import { mode } from '../helpers/arbitraries.ts';

const ACTIONS = new Set(['toggle', 'status', 'reset', 'set', 'invalid']);

const digitString = fc
  .string({
    maxLength: 400,
    minLength: 1,
    size: 'max',
    unit: fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7', '8', '9'),
  })
  .chain((digits) => fc.constantFrom('', 'k').map((unit) => `${digits}${unit}`));

const raw = fc.oneof(
  fc.anything(),
  fc.string(),
  fc.record({ text: fc.string() }),
  fc.array(fc.oneof(fc.record({ text: fc.string() }), fc.anything()), { maxLength: 4 })
);

describe('parseCommandArg properties', () => {
  test('never throws, and every set action carries a valid patch', () => {
    fc.assert(
      fc.property(raw, (value) => {
        const action = parseCommandArg(value);
        expect(ACTIONS.has(action.type)).toBe(true);
        if (action.type === 'set') expect(sanitizePatch(action.patch)).toEqual(action.patch);
      })
    );
  });

  test('accepts modes in any case with surrounding whitespace', () => {
    fc.assert(
      fc.property(mode, fc.boolean(), fc.constantFrom('', ' ', '\t', '  '), (m, upper, pad) => {
        const text = `${pad}${upper ? m.toUpperCase() : m}${pad}`;
        expect(parseCommandArg(text)).toEqual({ patch: { mode: m }, type: 'set' });
      })
    );
  });

  test('pings accepts 0 to the limit and rejects anything above', () => {
    fc.assert(
      fc.property(fc.integer({ max: MAX_PINGS_LIMIT * 10, min: 0 }), (count) => {
        expect(parseCommandArg(`pings ${count}`)).toEqual(
          count <= MAX_PINGS_LIMIT
            ? { patch: { maxPings: count }, type: 'set' }
            : { type: 'invalid' }
        );
      })
    );
  });

  test('min reads a count with an optional k suffix', () => {
    fc.assert(
      fc.property(fc.nat({ max: 10_000_000 }), fc.boolean(), (count, thousands) => {
        expect(parseCommandArg(`min ${count}${thousands ? 'k' : ''}`)).toEqual({
          patch: { minContextTokens: count * (thousands ? 1000 : 1) },
          type: 'set',
        });
      })
    );
  });

  test('min with any digit string gives a valid patch or invalid', () => {
    // Long digit strings reach Number's limits (precision, then Infinity past ~309 digits).
    fc.assert(
      fc.property(digitString, (count) => {
        const action = parseCommandArg(`min ${count}`);
        if (action.type === 'set') expect(sanitizePatch(action.patch)).toEqual(action.patch);
        else expect(action.type).toBe('invalid');
      })
    );
  });
});
