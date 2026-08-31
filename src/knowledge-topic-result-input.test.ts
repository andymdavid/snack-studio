import { expect, test } from 'bun:test';
import { validateSuccessfulKnowledgeTopicResult } from './knowledge-topic-result-input.ts';

test('validates a non-overlapping transcript topic index beside grounded knowledge', () => {
  const result = validateSuccessfulKnowledgeTopicResult({ requestId: 'r', attemptId: 'a', runId: null, episodeId: 'e', operation: 'publication-metadata', inputRevisionId: 't', resultSchemaVersion: '5', pipelineVersion: '4', nodes: [{ key: 'claim-one', kind: 'claim', title: 'A claim', summary: 'A grounded claim.', confidence: 0.9, evidence: [{ excerpt: 'Bitcoin hardware wallets change the security boundary.', speaker: 'Pete' }] }], edges: [], snackLinks: [], topics: [{ key: 'bitcoin', existingTopicId: null, name: 'Bitcoin', description: 'Bitcoin systems and their use.', parentTopicKey: null }, { key: 'hardware-wallets', existingTopicId: null, name: 'Hardware wallets', description: 'Dedicated devices for holding signing keys.', parentTopicKey: 'bitcoin' }], topicPassages: [{ key: 'passage-1', primaryTopicKey: 'hardware-wallets', secondaryTopicKeys: ['bitcoin'], summary: 'A hardware-wallet security discussion.', evidenceIds: ['ev-0001'], excerpt: 'Bitcoin hardware wallets change the security boundary.', transcriptStart: 10, transcriptEnd: 64, wordCount: 7, confidence: 0.9 }] });
  expect(result.ok).toBeTrue();
  if (result.ok) expect(result.value.topicPassages[0]).toMatchObject({ primaryTopicKey: 'hardware-wallets', wordCount: 7 });
});

test('rejects overlapping primary topic coverage', () => {
  const shared = { requestId: 'r', attemptId: 'a', runId: null, episodeId: 'e', operation: 'publication-metadata', inputRevisionId: 't', resultSchemaVersion: '5', pipelineVersion: '4', nodes: [{ key: 'claim-one', kind: 'claim', title: 'A claim', summary: 'A grounded claim.', confidence: 0.9, evidence: [{ excerpt: 'Grounded.', speaker: null }] }], edges: [], snackLinks: [], topics: [{ key: 'security', existingTopicId: 'privacy-security', name: 'Privacy & Security', description: 'Security.', parentTopicKey: null }] };
  const result = validateSuccessfulKnowledgeTopicResult({ ...shared, topicPassages: [{ key: 'one', primaryTopicKey: 'security', secondaryTopicKeys: [], summary: 'One.', evidenceIds: ['ev-1'], excerpt: 'One.', transcriptStart: 0, transcriptEnd: 20, wordCount: 4, confidence: 0.9 }, { key: 'two', primaryTopicKey: 'security', secondaryTopicKeys: [], summary: 'Two.', evidenceIds: ['ev-2'], excerpt: 'Two.', transcriptStart: 10, transcriptEnd: 30, wordCount: 4, confidence: 0.9 }] });
  expect(result.ok).toBeFalse();
});
