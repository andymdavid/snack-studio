import { describe, expect, test } from 'bun:test';
import { normalizeThemeEvidence, transcriptContainsEvidence } from './theme-results.ts';

describe('theme evidence normalization', () => {
  test('accepts a byte-exact bounded excerpt ending in an abandoned word fragment', () => {
    const transcript = 'I would sit there and go, okay, what do we-\n\nAndy\n13:11\nActually do next';
    expect(transcriptContainsEvidence(transcript, 'I would sit there and go, okay, what do we-')).toBeTrue();
  });
  test('tolerates abandoned ASR word starts without changing ordinary hyphenation', () => {
    expect(normalizeThemeEvidence('they would s- these bigger players spend time e-educating the market'))
      .toBe('they would these bigger players spend time educating the market');
    expect(normalizeThemeEvidence('a well-known limit')).toBe('a well-known limit');
  });

  test('ignores diarisation markers inserted inside an exact spoken excerpt', () => {
    const transcript = `Pete:\n33:26\nAnd your business is going to be a collection\n\nPete:\n33:27\nof data, customers, processors,\n\nPete:\n33:31\nand things that are all enshrined in software.`;
    expect(normalizeThemeEvidence(transcript)).toContain(
      normalizeThemeEvidence('And your business is going to be a collection of data, customers, processors, and things that are all enshrined in software.'),
    );
  });
});
