import { describe, expect, test } from 'bun:test';
import { validateSuccessfulPublicTranscriptResult } from './public-transcript-result-input.ts';

describe('public transcript callback', () => {
  test('accepts a complete derived reading copy', () => {
    const result = validateSuccessfulPublicTranscriptResult({ requestId: 'r', attemptId: 'a', runId: null, episodeId: 'e', operation: 'transcript-normalization', inputRevisionId: 't', resultSchemaVersion: '1', pipelineVersion: '1', transcriptText: 'Speaker: A faithful public transcript '.repeat(10), cleanupSummary: ['Regularized punctuation'] });
    expect(result.ok).toBe(true);
  });
  test('rejects an excerpt in place of a complete transcript', () => {
    expect(validateSuccessfulPublicTranscriptResult({ operation: 'transcript-normalization', transcriptText: 'Too short', cleanupSummary: [] }).ok).toBe(false);
  });
});
