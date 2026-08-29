import { describe, expect, test } from 'bun:test';
import { deriveGraphFocus, deriveGraphReview, deriveKnowledgeFocus } from '../public/graph-review.js';

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

describe('deriveGraphFocus', () => {
  test('defaults to the most connected approved node and exposes edge direction', () => {
    const result = deriveGraphFocus(payload, '', { includeDrafts: false });
    expect(result.focus?.candidateId).toBe('a');
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0].direction).toBe('outgoing');
  });
  test('can include draft knowledge while it is being curated', () => {
    const result = deriveGraphFocus(payload, 'b', { includeDrafts: true });
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0].direction).toBe('incoming');
  });
});

test('deriveKnowledgeFocus connects the collection, episodes, contributors, transcript ideas and Snacks', () => {
  const result = deriveKnowledgeFocus({ ...payload, contributors: [{ contributorId: 'pete', name: 'Pete', role: 'Host', shortBio: 'Host of Intelligence Snacks.', aliases: ['Pete'], episodeIds: ['episode-1'] }], knowledge: { nodes: [
    { id: 'claim-1', episodeId: 'episode-1', kind: 'claim', title: 'Memory compounds', summary: 'Connections increase value.', confidence: 0.9, reviewState: 'accepted', evidence: [{ id: 'ev-1', excerpt: 'the more connected it gets', speaker: 'Pete' }] },
    { id: 'example-1', episodeId: 'episode-1', kind: 'example', title: 'A working memory', summary: 'A concrete instance.', confidence: 0.8, reviewState: 'accepted', evidence: [] },
  ], edges: [{ id: 'edge-1', sourceNodeId: 'example-1', targetNodeId: 'claim-1', relationshipType: 'exemplifies', explanation: 'The case makes the claim concrete.', confidence: 0.85, reviewState: 'accepted' }], snackLinks: [{ id: 'link-1', knowledgeNodeId: 'claim-1', candidateId: 'a', relationshipType: 'developed-into', confidence: 0.9, reviewState: 'accepted' }] } }, 'knowledge:claim-1');
  expect(result.focus).toMatchObject({ kind: 'claim', title: 'Memory compounds' });
  expect(result.explicitFocus).toBeTrue();
  expect(result.connections.map((item) => item.relationshipType).sort()).toEqual(['contributed', 'developed-into', 'exemplifies']);
  expect(result.allConnections).toHaveLength(12);
  expect(result.nodes).toContainEqual(expect.objectContaining({ id: 'root:intelligence-snacks', kind: 'root' }));
  expect(result.nodes).toContainEqual(expect.objectContaining({ id: 'contributor:pete', kind: 'contributor' }));
  expect(result.nodes.filter((node) => ['claim','example'].includes(node.kind))).toHaveLength(2);
  expect(deriveKnowledgeFocus(payload).explicitFocus).toBeFalse();
});
