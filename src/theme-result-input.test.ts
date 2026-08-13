import { describe, expect, test } from 'bun:test';
import { validateSuccessfulThemeResult } from './theme-result-input.ts';

const result = {
  requestId: 'request-1', attemptId: 'attempt-1', runId: null, episodeId: 'episode-1', operation: 'publication-metadata',
  inputRevisionId: 'transcript-1', resultSchemaVersion: '2', pipelineVersion: '2',
  episodeThemes: [
    { key: 'agents', existingThemeId: 'agents', name: 'Agents', description: 'Agent systems', rationale: 'Repeated throughout', evidenceExcerpt: 'agent harness' },
    { key: 'software-systems', existingThemeId: 'software-systems', name: 'Software Systems', description: 'Software architecture and operations.', rationale: 'Repeated throughout', evidenceExcerpt: 'learned in production' },
  ],
  snackAssignments: [{ candidateId: 'candidate-1', revisionId: 'revision-1', themeKey: 'agents', rationale: 'The Snack concerns agent systems.' }],
};

describe('theme metadata callback', () => {
  test('accepts reusable and proposed episode themes with Snack alignment', () => {
    expect(validateSuccessfulThemeResult(result).ok).toBe(true);
  });

  test('rejects a Snack theme outside the resolved episode set', () => {
    const validation = validateSuccessfulThemeResult({ ...result, snackAssignments: [{ ...result.snackAssignments[0], themeKey: 'unresolved' }] });
    expect(validation).toEqual({ ok: false, error: 'Snack assignment 1 must use one resolved episode theme' });
  });

  test('rejects pipeline-created filter categories', () => {
    const validation = validateSuccessfulThemeResult({ ...result, episodeThemes: [{ ...result.episodeThemes[0], key: 'narrow', existingThemeId: null, name: 'Narrow episode concept' }] });
    expect(validation).toEqual({ ok: false, error: 'episode theme narrow must use one governed theme from the registry' });
  });
});
