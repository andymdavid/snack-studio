import { describe, expect, test } from 'bun:test';
import { buildApprovedGraphProjection } from './graph-projection.ts';

const candidates = [
  { candidateId: 'a', episodeId: 'episode-1', title: 'A', standfirst: 'First idea', episodeNumber: 1, episodeTitle: 'Origins' },
  { candidateId: 'b', episodeId: 'episode-2', title: 'B', standfirst: 'Second idea', episodeNumber: 2, episodeTitle: 'Systems' },
] as any;

describe('buildApprovedGraphProjection', () => {
  test('emits stable Snack and Episode nodes with provenance edges', () => {
    const projection = buildApprovedGraphProjection(candidates, []);
    expect(projection.nodes).toHaveLength(4);
    expect(projection.edges.filter((edge) => edge.type === 'derived-from')).toHaveLength(2);
    expect(projection.nodes[0].id).toContain('intelligence-snacks:snack:');
  });
  test('exports approved editorial relationships and excludes drafts', () => {
    const relationship = { id: 'rel-1', sourceCandidateId: 'a', targetCandidateId: 'b', relationshipType: 'develops', explanation: 'B develops A.', reviewState: 'approved' } as any;
    const projection = buildApprovedGraphProjection(candidates, [relationship, { ...relationship, id: 'rel-2', reviewState: 'draft' }]);
    expect(projection.edges.filter((edge) => edge.type === 'develops')).toEqual([{ id: 'intelligence-snacks:relationship:rel-1', from: 'intelligence-snacks:snack:a', to: 'intelligence-snacks:snack:b', type: 'develops', properties: { relationshipId: 'rel-1', explanation: 'B develops A.' } }]);
  });
});
