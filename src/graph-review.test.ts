import { describe, expect, test } from 'bun:test';
import { deriveGraphReview } from '../public/graph-review.js';

const payload = {
  candidates: [
    { candidateId: 'a', episodeId: 'episode-1', episodeNumber: 1, episodeTitle: 'Origins', title: 'A' },
    { candidateId: 'b', episodeId: 'episode-1', episodeNumber: 1, episodeTitle: 'Origins', title: 'B' },
    { candidateId: 'c', episodeId: 'episode-2', episodeNumber: 2, episodeTitle: 'Systems', title: 'C' },
  ],
  relationships: [
    { id: 'one', sourceCandidateId: 'a', targetCandidateId: 'b', sourceTitle: 'A', targetTitle: 'B', relationshipType: 'develops', reviewState: 'draft', explanation: 'B extends A.' },
    { id: 'two', sourceCandidateId: 'a', targetCandidateId: 'c', sourceTitle: 'A', targetTitle: 'C', relationshipType: 'contradicts', reviewState: 'approved', explanation: 'C challenges A.', evidenceExcerpt: 'A useful tension.' },
  ],
};

describe('deriveGraphReview', () => {
  test('groups visible relationships around their source Snack and reports review progress', () => {
    const result = deriveGraphReview(payload);
    expect(result.total).toBe(2); expect(result.reviewed).toBe(1); expect(result.drafts).toBe(1);
    expect(result.groups).toHaveLength(1); expect(result.groups[0].relationships).toHaveLength(2);
  });
  test('filters by source episode, state, type and searchable context', () => {
    expect(deriveGraphReview(payload, { episodeId: 'episode-2' }).visibleCount).toBe(0);
    expect(deriveGraphReview(payload, { reviewState: 'draft', relationshipType: 'develops' }).visibleCount).toBe(1);
    expect(deriveGraphReview(payload, { query: 'tension' }).groups[0].relationships[0].id).toBe('two');
  });
});
