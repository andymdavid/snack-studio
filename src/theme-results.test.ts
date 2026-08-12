import { describe, expect, test } from 'bun:test';
import { normalizeThemeEvidence } from './theme-results.ts';

describe('theme evidence normalization', () => {
  test('tolerates abandoned ASR word starts without changing ordinary hyphenation', () => {
    expect(normalizeThemeEvidence('they would s- these bigger players spend time e-educating the market'))
      .toBe('they would these bigger players spend time educating the market');
    expect(normalizeThemeEvidence('a well-known limit')).toBe('a well-known limit');
  });
});
