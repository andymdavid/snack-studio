import { validateSuccessfulKnowledgeResult, type SuccessfulKnowledgeResult } from './knowledge-result-input.ts';

export type SuccessfulKnowledgeTopicResult = Omit<SuccessfulKnowledgeResult, 'resultSchemaVersion'> & {
  resultSchemaVersion: '5';
  topics: Array<{ key: string; existingTopicId: string | null; name: string; description: string; parentTopicKey: string | null }>;
  topicPassages: Array<{ key: string; primaryTopicKey: string; secondaryTopicKeys: string[]; summary: string; evidenceIds: string[]; excerpt: string; transcriptStart: number; transcriptEnd: number; wordCount: number; confidence: number }>;
};

export function validateSuccessfulKnowledgeTopicResult(value: Record<string, unknown>): { ok: true; value: SuccessfulKnowledgeTopicResult } | { ok: false; error: string } {
  try {
    if (value.resultSchemaVersion !== '5') throw new Error('knowledge topic callback contract mismatch');
    const graph = validateSuccessfulKnowledgeResult({ ...value, resultSchemaVersion: '4' }, { allowEmptyNodes: true });
    if (!graph.ok) throw new Error(graph.error);
    if (!Array.isArray(value.topics) || !value.topics.length || value.topics.length > 40) throw new Error('topics must contain 1 to 40 used discussion topics');
    const topics = value.topics.map((item, index) => {
      const row = item as Record<string, unknown>; const key = String(row?.key || '').trim(); const name = String(row?.name || '').trim(); const description = String(row?.description || '').trim();
      if (!key || !name || !description) throw new Error(`topic ${index + 1} is incomplete`);
      return { key, existingTopicId: typeof row.existingTopicId === 'string' && row.existingTopicId.trim() ? row.existingTopicId.trim() : null, name: name.slice(0, 120), description: description.slice(0, 1000), parentTopicKey: typeof row.parentTopicKey === 'string' && row.parentTopicKey.trim() ? row.parentTopicKey.trim() : null };
    });
    const topicKeys = new Set(topics.map((topic) => topic.key)); if (topicKeys.size !== topics.length) throw new Error('topic keys must be unique');
    if (new Set(topics.map((topic) => topic.name.toLocaleLowerCase())).size !== topics.length) throw new Error('topic names must be unique');
    for (const topic of topics) if (topic.parentTopicKey && !topicKeys.has(topic.parentTopicKey)) throw new Error(`topic ${topic.key} has an unknown parent`);
    const parentByKey = new Map(topics.map((topic) => [topic.key, topic.parentTopicKey]));
    for (const topic of topics) { const seen = new Set<string>([topic.key]); let parent = topic.parentTopicKey; while (parent) { if (seen.has(parent)) throw new Error(`topic ${topic.key} creates a parent cycle`); seen.add(parent); parent = parentByKey.get(parent) || null; } }
    if (!Array.isArray(value.topicPassages) || !value.topicPassages.length || value.topicPassages.length > 200) throw new Error('topicPassages must contain 1 to 200 grounded passages');
    const confidence = (raw: unknown, label: string) => { const result = Number(raw); if (!Number.isFinite(result) || result < 0 || result > 1) throw new Error(`${label} confidence must be between 0 and 1`); return result; };
    const topicPassages = value.topicPassages.map((item, index) => {
      const row = item as Record<string, unknown>; const key = String(row?.key || '').trim(); const primaryTopicKey = String(row?.primaryTopicKey || '').trim(); const summary = String(row?.summary || '').trim(); const excerpt = String(row?.excerpt || '');
      const secondaryTopicKeys = Array.isArray(row.secondaryTopicKeys) ? [...new Set(row.secondaryTopicKeys.map(String).filter(Boolean))] : [];
      const evidenceIds = Array.isArray(row.evidenceIds) ? row.evidenceIds.map(String).filter(Boolean) : [];
      const transcriptStart = Number(row.transcriptStart); const transcriptEnd = Number(row.transcriptEnd); const wordCount = Number(row.wordCount);
      if (!key || !topicKeys.has(primaryTopicKey) || !summary || !excerpt || !evidenceIds.length || !Number.isInteger(transcriptStart) || !Number.isInteger(transcriptEnd) || transcriptStart < 0 || transcriptEnd <= transcriptStart || !Number.isInteger(wordCount) || wordCount <= 0) throw new Error(`topic passage ${index + 1} is incomplete`);
      if (secondaryTopicKeys.some((topicKey) => !topicKeys.has(topicKey) || topicKey === primaryTopicKey)) throw new Error(`topic passage ${key} has invalid secondary topics`);
      return { key, primaryTopicKey, secondaryTopicKeys, summary: summary.slice(0, 1000), evidenceIds, excerpt, transcriptStart, transcriptEnd, wordCount, confidence: confidence(row.confidence, `topic passage ${key}`) };
    }).sort((a, b) => a.transcriptStart - b.transcriptStart);
    for (let index = 1; index < topicPassages.length; index++) if (topicPassages[index].transcriptStart < topicPassages[index - 1].transcriptEnd) throw new Error('primary topic passages must not overlap');
    return { ok: true, value: { ...graph.value, resultSchemaVersion: '5', topics, topicPassages } };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}
