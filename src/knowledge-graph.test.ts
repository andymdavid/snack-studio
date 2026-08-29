import { describe, expect, test } from 'bun:test';
import { assembleKnowledgeGraph } from './knowledge-graph.ts';

describe('assembleKnowledgeGraph', () => {
  test('keeps proposed transcript knowledge visible with grounded evidence and Snack links', () => {
    const graph = assembleKnowledgeGraph([
      { id: 'claim-1', episode_id: 'episode-1', source_transcript_revision_id: 'revision-1', kind: 'claim', title: 'Memory compounds', summary: 'Connected memory becomes more useful over time.', confidence: 0.86, review_state: 'proposed', origin: 'pipeline', created_at: 1, updated_at: 1 },
    ], [
      { id: 'evidence-1', knowledge_node_id: 'claim-1', excerpt: 'The more connected it gets, the more useful it becomes.', speaker: 'Pete', transcript_start: 120, transcript_end: 178 },
    ], [], [
      { id: 'link-1', episode_id: 'episode-1', knowledge_node_id: 'claim-1', candidate_id: 'snack-1', relationship_type: 'developed-into', confidence: 0.9, review_state: 'proposed', origin: 'pipeline' },
    ]);
    expect(graph.nodes[0]).toMatchObject({ kind: 'claim', reviewState: 'proposed', confidence: 0.86 });
    expect(graph.nodes[0]?.evidence[0]).toMatchObject({ speaker: 'Pete', transcriptStart: 120 });
    expect(graph.snackLinks[0]).toMatchObject({ candidateId: 'snack-1', relationshipType: 'developed-into' });
  });
});
