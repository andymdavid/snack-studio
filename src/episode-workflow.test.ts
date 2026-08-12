import { describe, expect, test } from 'bun:test';
import { deriveEpisodeWorkflow } from './episode-workflow.ts';

const base = { hasTranscript: true, candidateCount: 7, episodeApproved: false, finalSetReady: false, generationStatus: 'completed', publicationActive: false, assetReviewCount: 0, packageReady: false, blockers: [], validationCurrent: false, publicationCurrent: false, deploymentCurrent: false };

describe('deriveEpisodeWorkflow', () => {
  test('keeps mechanical work actionless and routes editorial work to review', () => {
    expect(deriveEpisodeWorkflow({ ...base, candidateCount: 0, generationStatus: 'running' }).phase).toBe('generating');
    expect(deriveEpisodeWorkflow(base).recommendedAction?.route).toBe('review');
    expect(deriveEpisodeWorkflow({ ...base, finalSetReady: true }).phase).toBe('final-set-ready');
  });

  test('orders immutable release gates', () => {
    const approved = { ...base, episodeApproved: true, packageReady: true };
    expect(deriveEpisodeWorkflow(approved).phase).toBe('ready-to-validate');
    expect(deriveEpisodeWorkflow({ ...approved, validationCurrent: true }).phase).toBe('validated');
    expect(deriveEpisodeWorkflow({ ...approved, validationCurrent: true, publicationCurrent: true }).phase).toBe('published-main');
    expect(deriveEpisodeWorkflow({ ...approved, validationCurrent: true, publicationCurrent: true, deploymentCurrent: true }).phase).toBe('deployed');
  });
});
