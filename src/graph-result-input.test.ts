import { describe, expect, test } from 'bun:test';
import { validateSuccessfulGraphResult } from './graph-result-input.ts';

test('graph callback requires typed evidence-backed suggestions', () => {
  const result = validateSuccessfulGraphResult({ requestId: 'r', attemptId: 'a', runId: null, episodeId: 'e', operation: 'publication-metadata', inputRevisionId: 't', resultSchemaVersion: '3', pipelineVersion: '1', suggestions: [{ sourceCandidateId: 'one', targetCandidateId: 'two', relationshipType: 'develops', explanation: 'The second advances the mechanism.', evidence: 'Both Snacks describe the same mechanism at different stages.' }] });
  expect(result.ok).toBe(true);
});
