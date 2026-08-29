import { KNOWLEDGE_NODE_KINDS } from './knowledge-graph.ts';

const EDGE_TYPES = ['related-to','develops','supports','contradicts','exemplifies','enables','caused-by'] as const;
const SNACK_LINK_TYPES = ['developed-into','supports','summarised-by','related-to'] as const;
export type SuccessfulKnowledgeResult = {
  requestId: string; attemptId: string; runId: string | null; episodeId: string; operation: 'publication-metadata';
  inputRevisionId: string; resultSchemaVersion: '4'; pipelineVersion: string;
  nodes: Array<{ key: string; kind: typeof KNOWLEDGE_NODE_KINDS[number]; title: string; summary: string; confidence: number; evidence: Array<{ excerpt: string; speaker: string | null }> }>;
  edges: Array<{ sourceKey: string; targetKey: string; relationshipType: typeof EDGE_TYPES[number]; explanation: string; confidence: number }>;
  snackLinks: Array<{ nodeKey: string; candidateId: string; relationshipType: typeof SNACK_LINK_TYPES[number]; confidence: number }>;
};

export function validateSuccessfulKnowledgeResult(value: Record<string, unknown>): { ok: true; value: SuccessfulKnowledgeResult } | { ok: false; error: string } {
  try {
    const required = (key: string) => { const result = typeof value[key] === 'string' ? String(value[key]).trim() : ''; if (!result) throw new Error(`${key} is required`); return result; };
    const confidence = (raw: unknown, label: string) => { const result = Number(raw); if (!Number.isFinite(result) || result < 0 || result > 1) throw new Error(`${label} confidence must be between 0 and 1`); return result; };
    if (value.operation !== 'publication-metadata' || value.resultSchemaVersion !== '4') throw new Error('knowledge callback contract mismatch');
    if (!Array.isArray(value.nodes) || !value.nodes.length || value.nodes.length > 60) throw new Error('nodes must contain 1 to 60 transcript ideas');
    const nodes = value.nodes.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`node ${index + 1} must be an object`);
      const row = item as Record<string, unknown>; const key = String(row.key || '').trim(); const kind = String(row.kind || '') as SuccessfulKnowledgeResult['nodes'][number]['kind'];
      const title = String(row.title || '').trim(); const summary = String(row.summary || '').trim();
      if (!key || !KNOWLEDGE_NODE_KINDS.includes(kind) || !title || !summary) throw new Error(`node ${index + 1} is incomplete`);
      if (!Array.isArray(row.evidence) || !row.evidence.length || row.evidence.length > 4) throw new Error(`node ${key} must have 1 to 4 evidence excerpts`);
      const evidence = row.evidence.map((item, evidenceIndex) => { const evidenceRow = item as Record<string, unknown>; const excerpt = String(evidenceRow?.excerpt || '').trim(); if (!excerpt) throw new Error(`node ${key} evidence ${evidenceIndex + 1} is empty`); return { excerpt, speaker: typeof evidenceRow.speaker === 'string' && evidenceRow.speaker.trim() ? evidenceRow.speaker.trim() : null }; });
      return { key, kind, title: title.slice(0, 200), summary: summary.slice(0, 2000), confidence: confidence(row.confidence, `node ${key}`), evidence };
    });
    const keys = new Set(nodes.map((node) => node.key)); if (keys.size !== nodes.length) throw new Error('node keys must be unique');
    const rows = Array.isArray(value.edges) ? value.edges : []; if (rows.length > 120) throw new Error('edges must contain no more than 120 connections');
    const edges = rows.map((item, index) => { const row = item as Record<string, unknown>; const sourceKey = String(row?.sourceKey || '').trim(); const targetKey = String(row?.targetKey || '').trim(); const relationshipType = String(row?.relationshipType || '') as SuccessfulKnowledgeResult['edges'][number]['relationshipType']; const explanation = String(row?.explanation || '').trim(); if (!keys.has(sourceKey) || !keys.has(targetKey) || sourceKey === targetKey || !EDGE_TYPES.includes(relationshipType) || !explanation) throw new Error(`edge ${index + 1} is invalid`); return { sourceKey, targetKey, relationshipType, explanation: explanation.slice(0, 1000), confidence: confidence(row.confidence, `edge ${index + 1}`) }; });
    const linkRows = Array.isArray(value.snackLinks) ? value.snackLinks : []; if (linkRows.length > 60) throw new Error('snackLinks must contain no more than 60 links');
    const snackLinks = linkRows.map((item, index) => { const row = item as Record<string, unknown>; const nodeKey = String(row?.nodeKey || '').trim(); const candidateId = String(row?.candidateId || '').trim(); const relationshipType = String(row?.relationshipType || '') as SuccessfulKnowledgeResult['snackLinks'][number]['relationshipType']; if (!keys.has(nodeKey) || !candidateId || !SNACK_LINK_TYPES.includes(relationshipType)) throw new Error(`Snack link ${index + 1} is invalid`); return { nodeKey, candidateId, relationshipType, confidence: confidence(row.confidence, `Snack link ${index + 1}`) }; });
    return { ok: true, value: { requestId: required('requestId'), attemptId: required('attemptId'), runId: typeof value.runId === 'string' ? value.runId : null, episodeId: required('episodeId'), operation: 'publication-metadata', inputRevisionId: required('inputRevisionId'), resultSchemaVersion: '4', pipelineVersion: required('pipelineVersion'), nodes, edges, snackLinks } };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}
