import { describe, expect, test } from 'bun:test';
import { deriveEpisodeWorkflow, deriveEpisodeWorkProjection, selectWorkQueue, type EpisodeWorkProjection } from './episode-workflow.ts';

const base = { hasTranscript: true, candidateCount: 7, episodeApproved: false, finalSetReady: false, generationStatus: 'completed', publicationActive: false, assetReviewCount: 0, packageReady: false, blockers: [], validationCurrent: false, publicationCurrent: false, deploymentCurrent: false };

describe('deriveEpisodeWorkflow', () => {
  test('keeps mechanical work actionless and routes editorial work to review', () => {
    expect(deriveEpisodeWorkflow({ ...base, candidateCount: 0, generationStatus: 'running' }).phase).toBe('generating');
    expect(deriveEpisodeWorkflow(base).recommendedAction?.route).toBe('review');
    expect(deriveEpisodeWorkflow({ ...base, finalSetReady: true }).phase).toBe('final-set-ready');
    expect(deriveEpisodeWorkflow({ ...base, episodeApproved: true, assetReviewCount: 2 }).recommendedAction?.route).toBe('assets');
  });

  test('orders immutable release gates', () => {
    const approved = { ...base, episodeApproved: true, packageReady: true };
    expect(deriveEpisodeWorkflow(approved).phase).toBe('ready-to-validate');
    expect(deriveEpisodeWorkflow({ ...approved, validationCurrent: true }).phase).toBe('validated');
    expect(deriveEpisodeWorkflow({ ...approved, validationCurrent: true, publicationCurrent: true }).phase).toBe('published-main');
    expect(deriveEpisodeWorkflow({ ...approved, validationCurrent: true, publicationCurrent: true, deploymentCurrent: true }).phase).toBe('deployed');
  });
});

describe('deriveEpisodeWorkProjection', () => {
  const projectionBase = { hasTranscript:true, generationStatus:'completed', candidateCount:7, candidateDecisionCount:0, proposalCount:0, finalSetReady:true, finalSetApproved:true, assetReviewCount:0, assetReasons:[], publicationActive:false, packageReady:false, blockers:[], validationCurrent:false, publicationCurrent:false, deploymentCurrent:false };
  test('keeps Snack and asset work independently actionable', () => {
    const work = deriveEpisodeWorkProjection({ ...projectionBase, candidateDecisionCount:1, proposalCount:1, assetReviewCount:3, assetReasons:['Three assets need review.'] });
    expect(work.snacks.outstandingCount).toBe(2); expect(work.assets.outstandingCount).toBe(3);
    expect(work.snacks.state).toBe('needs-review'); expect(work.assets.state).toBe('needs-review');
  });
  test('keeps publication eligible while parallel review work remains', () => {
    const work = deriveEpisodeWorkProjection({ ...projectionBase, candidateDecisionCount:1, assetReviewCount:2, assetReasons:['Two assets need review.'], blockers:[{ message:'Assets remain.' }] });
    expect(work.publication.eligible).toBe(true); expect(work.publication.state).toBe('blocked');
    expect(work.snacks.outstandingCount).toBe(1); expect(work.assets.outstandingCount).toBe(2);
  });
  test('completing assets cannot change Snack membership', () => {
    const before = deriveEpisodeWorkProjection({ ...projectionBase, candidateDecisionCount:1, assetReviewCount:1, assetReasons:['One asset remains.'] });
    const after = deriveEpisodeWorkProjection({ ...projectionBase, candidateDecisionCount:1 });
    expect(before.snacks).toEqual(after.snacks); expect(after.assets.ready).toBe(true);
  });
  test('keeps an approved Snack workspace available without inventing outstanding work', () => {
    const work = deriveEpisodeWorkProjection(projectionBase);
    expect(work.snacks.available).toBe(true); expect(work.snacks.outstandingCount).toBe(0); expect(work.snacks.state).toBe('approved');
  });
  test('projects one episode into every applicable work surface independently', () => {
    const work = { episodeId:'episode-1', episodeNumber:1, title:'One', updatedAt:1,
      ...deriveEpisodeWorkProjection({ ...projectionBase, candidateDecisionCount:1, assetReviewCount:2, assetReasons:['Two assets remain.'], blockers:[{ message:'Assets remain.' }] }) } as EpisodeWorkProjection;
    expect(selectWorkQueue([work], 'snacks')).toHaveLength(1);
    expect(selectWorkQueue([work], 'assets')).toHaveLength(1);
    expect(selectWorkQueue([work], 'publications')).toHaveLength(1);
  });
});
