import { db } from './db.ts';

export const KNOWLEDGE_NODE_KINDS = ['concept', 'claim', 'example', 'question'] as const;
export type KnowledgeNodeKind = typeof KNOWLEDGE_NODE_KINDS[number];
export type KnowledgeReviewState = 'proposed' | 'accepted' | 'rejected';

export type KnowledgeEvidence = {
  id: string; knowledgeNodeId: string; excerpt: string; speaker: string | null;
  transcriptStart: number | null; transcriptEnd: number | null;
};

export type KnowledgeNode = {
  id: string; episodeId: string; sourceTranscriptRevisionId: string; kind: KnowledgeNodeKind;
  title: string; summary: string; confidence: number; reviewState: KnowledgeReviewState;
  origin: 'manual' | 'pipeline'; evidence: KnowledgeEvidence[]; createdAt: number; updatedAt: number;
};

export type KnowledgeEdge = {
  id: string; episodeId: string; sourceNodeId: string; targetNodeId: string; relationshipType: string;
  explanation: string | null; confidence: number; reviewState: KnowledgeReviewState;
  origin: 'manual' | 'pipeline'; createdAt: number; updatedAt: number;
};

export type KnowledgeSnackLink = {
  id: string; episodeId: string; knowledgeNodeId: string; candidateId: string; relationshipType: string;
  confidence: number; reviewState: KnowledgeReviewState; origin: 'manual' | 'pipeline';
};

export function assembleKnowledgeGraph(
  nodeRows: Record<string, unknown>[], evidenceRows: Record<string, unknown>[],
  edgeRows: Record<string, unknown>[], snackLinkRows: Record<string, unknown>[],
) {
  const evidenceByNode = new Map<string, KnowledgeEvidence[]>();
  for (const row of evidenceRows) {
    const item = { id: String(row.id), knowledgeNodeId: String(row.knowledge_node_id), excerpt: String(row.excerpt),
      speaker: row.speaker == null ? null : String(row.speaker), transcriptStart: row.transcript_start == null ? null : Number(row.transcript_start),
      transcriptEnd: row.transcript_end == null ? null : Number(row.transcript_end) };
    evidenceByNode.set(item.knowledgeNodeId, [...(evidenceByNode.get(item.knowledgeNodeId) || []), item]);
  }
  const nodes: KnowledgeNode[] = nodeRows.map((row) => ({ id: String(row.id), episodeId: String(row.episode_id),
    sourceTranscriptRevisionId: String(row.source_transcript_revision_id), kind: String(row.kind) as KnowledgeNodeKind,
    title: String(row.title), summary: String(row.summary), confidence: Number(row.confidence), reviewState: String(row.review_state) as KnowledgeReviewState,
    origin: String(row.origin) as KnowledgeNode['origin'], evidence: evidenceByNode.get(String(row.id)) || [],
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }));
  const edges: KnowledgeEdge[] = edgeRows.map((row) => ({ id: String(row.id), episodeId: String(row.episode_id),
    sourceNodeId: String(row.source_node_id), targetNodeId: String(row.target_node_id), relationshipType: String(row.relationship_type),
    explanation: row.explanation == null ? null : String(row.explanation), confidence: Number(row.confidence),
    reviewState: String(row.review_state) as KnowledgeReviewState, origin: String(row.origin) as KnowledgeEdge['origin'],
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }));
  const snackLinks: KnowledgeSnackLink[] = snackLinkRows.map((row) => ({ id: String(row.id), episodeId: String(row.episode_id),
    knowledgeNodeId: String(row.knowledge_node_id), candidateId: String(row.candidate_id), relationshipType: String(row.relationship_type),
    confidence: Number(row.confidence), reviewState: String(row.review_state) as KnowledgeReviewState,
    origin: String(row.origin) as KnowledgeSnackLink['origin'] }));
  return { nodes, edges, snackLinks };
}

export function listKnowledgeGraph(episodeId?: string) {
  const where = episodeId ? ' WHERE episode_id = ?1' : '';
  const args = episodeId ? [episodeId] : [];
  const nodes = db.query(`SELECT * FROM knowledge_nodes${where} ORDER BY created_at ASC`).all(...args) as Record<string, unknown>[];
  if (!nodes.length) return { nodes: [], edges: [], snackLinks: [] };
  const nodeIds = new Set(nodes.map((row) => String(row.id)));
  const evidence = (db.query('SELECT * FROM knowledge_evidence ORDER BY created_at ASC').all() as Record<string, unknown>[]).filter((row) => nodeIds.has(String(row.knowledge_node_id)));
  const edges = db.query(`SELECT * FROM knowledge_edges${where} ORDER BY created_at ASC`).all(...args) as Record<string, unknown>[];
  const links = db.query(`SELECT * FROM knowledge_snack_links${where} ORDER BY created_at ASC`).all(...args) as Record<string, unknown>[];
  return assembleKnowledgeGraph(nodes, evidence, edges, links);
}
