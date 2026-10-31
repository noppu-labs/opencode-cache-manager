import { describe, expect, test } from 'bun:test';

import {
  formatCompactTokens,
  formatMultiple,
  formatRemaining,
  formatUsd,
} from '../../src/utils/format.ts';

const MIN = 60_000;

describe('formatRemaining', () => {
  test('minutes, seconds and hours', () => {
    expect(formatRemaining(3_120_000)).toBe('52m');
    expect(formatRemaining(3 * MIN)).toBe('3m');
    expect(formatRemaining(45_000)).toBe('45s');
    expect(formatRemaining(3_900_000)).toBe('1h 05m');
    expect(formatRemaining(2 * 3_600_000)).toBe('2h 00m');
  });

  test('clamps negative durations to zero seconds', () => {
    expect(formatRemaining(-5)).toBe('0s');
  });
});

describe('formatCompactTokens', () => {
  test('plain numbers below 1,000', () => {
    expect(formatCompactTokens(0)).toBe('0');
    expect(formatCompactTokens(732)).toBe('732');
    expect(formatCompactTokens(999)).toBe('999');
  });

  test('one decimal in k below 100,000, dropping a trailing .0', () => {
    expect(formatCompactTokens(1000)).toBe('1k');
    expect(formatCompactTokens(14_800)).toBe('14.8k');
    expect(formatCompactTokens(16_100)).toBe('16.1k');
    expect(formatCompactTokens(16_000)).toBe('16k');
    expect(formatCompactTokens(99_949)).toBe('99.9k');
  });

  test('rounded k below 1,000,000', () => {
    expect(formatCompactTokens(99_950)).toBe('100k');
    expect(formatCompactTokens(123_456)).toBe('123k');
    expect(formatCompactTokens(999_400)).toBe('999k');
  });

  test('one decimal in M from 1,000,000, dropping a trailing .0', () => {
    expect(formatCompactTokens(999_500)).toBe('1M');
    expect(formatCompactTokens(1_200_000)).toBe('1.2M');
    expect(formatCompactTokens(2_000_000)).toBe('2M');
  });
});

describe('formatUsd', () => {
  test('two decimals, with a floor for sub-cent amounts', () => {
    expect(formatUsd(0.42)).toBe('$0.42');
    expect(formatUsd(12.5)).toBe('$12.50');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.004)).toBe('<$0.01');
  });

  test('negative amounts keep the sign', () => {
    expect(formatUsd(-0.02)).toBe('-$0.02');
    expect(formatUsd(-0.004)).toBe('-<$0.01');
  });
});

describe('formatMultiple', () => {
  test('one decimal below 10, none from 10', () => {
    expect(formatMultiple(9.04)).toBe('9×');
    expect(formatMultiple(9.44)).toBe('9.4×');
    expect(formatMultiple(12.6)).toBe('13×');
    expect(formatMultiple(0.8)).toBe('0.8×');
  });
});
