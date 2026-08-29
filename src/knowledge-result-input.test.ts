import { expect, test } from 'bun:test';
import { validateSuccessfulKnowledgeResult } from './knowledge-result-input.ts';

test('validates a grounded transcript knowledge result', () => {
  const result = validateSuccessfulKnowledgeResult({ requestId: 'r', attemptId: 'a', runId: null, episodeId: 'e', operation: 'publication-metadata', inputRevisionId: 't', resultSchemaVersion: '4', pipelineVersion: '2', nodes: [{ key: 'claim-memory', kind: 'claim', title: 'Memory compounds', summary: 'Connected memory becomes more valuable.', confidence: 0.9, evidence: [{ excerpt: 'the more connected it gets, the more useful it becomes', speaker: 'Pete' }] }], edges: [], snackLinks: [{ nodeKey: 'claim-memory', candidateId: 'snack-1', relationshipType: 'developed-into', confidence: 0.85 }] });
  expect(result.ok).toBe(true);
});

test('rejects ungrounded nodes and dangling edges', () => {
  const result = validateSuccessfulKnowledgeResult({ operation: 'publication-metadata', resultSchemaVersion: '4', nodes: [{ key: 'one', kind: 'claim', title: 'One', summary: 'Summary', confidence: 0.8, evidence: [] }], edges: [{ sourceKey: 'one', targetKey: 'missing', relationshipType: 'supports', explanation: 'No', confidence: 0.5 }] });
  expect(result.ok).toBe(false);
});
