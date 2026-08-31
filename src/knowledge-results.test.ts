import { expect, test } from 'bun:test';
import { shouldPreserveExistingGraph } from './knowledge-results.ts';

test('topic-index backfills preserve established graph nodes', () => {
  expect(shouldPreserveExistingGraph('5', 11)).toBeTrue();
  expect(shouldPreserveExistingGraph('5', 0)).toBeFalse();
  expect(shouldPreserveExistingGraph('4', 11)).toBeFalse();
});
