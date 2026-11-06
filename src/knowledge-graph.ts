import type { Database } from 'bun:sqlite';
import { db } from './db.ts';
import { speakerForTranscriptExcerpt } from './publication-metadata.ts';
import { CURRENT_KNOWLEDGE_GRAPH_CONTRACT } from './pipeline-requests.ts';

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

export function getEpisodeGraphReadiness(episodeId: string, database: Database = db) {
  const episode = database.query('SELECT active_transcript_revision_id FROM episodes WHERE id=?1').get(episodeId) as { active_transcript_revision_id: string | null } | null;
  const transcriptRevisionId = episode?.active_transcript_revision_id || null;
  if (!transcriptRevisionId) return { state: 'blocked', ready: false, transcriptRevisionId: null, request: null, nodeCount: 0, edgeCount: 0, passageCount: 0, reason: 'Save an active transcript before building the graph.' };
  const row = database.query(`SELECT * FROM pipeline_requests WHERE episode_id=?1 AND input_transcript_revision_id=?2
    AND pipeline_name=?3 AND pipeline_version=?4 AND prompt_suite_version=?5 AND result_schema_version=?6
    ORDER BY created_at DESC LIMIT 1`).get(episodeId, transcriptRevisionId, CURRENT_KNOWLEDGE_GRAPH_CONTRACT.pipelineName,
      CURRENT_KNOWLEDGE_GRAPH_CONTRACT.pipelineVersion, CURRENT_KNOWLEDGE_GRAPH_CONTRACT.promptSuiteVersion,
      CURRENT_KNOWLEDGE_GRAPH_CONTRACT.resultSchemaVersion) as Record<string, unknown> | null;
  const counts = database.query(`SELECT
    (SELECT COUNT(*) FROM knowledge_nodes WHERE episode_id=?1 AND source_transcript_revision_id=?2) node_count,
    (SELECT COUNT(*) FROM knowledge_edges WHERE episode_id=?1) edge_count,
    (SELECT COUNT(*) FROM transcript_topic_passages WHERE episode_id=?1 AND transcript_revision_id=?2) passage_count,
    (SELECT COUNT(*) FROM transcript_topic_analyses WHERE episode_id=?1 AND transcript_revision_id=?2) analysis_count`).get(episodeId, transcriptRevisionId) as { node_count: number; edge_count: number; passage_count: number; analysis_count: number };
  const request = row ? { id: String(row.id), status: String(row.status), failureSummary: row.failure_summary == null ? null : String(row.failure_summary), updatedAt: Number(row.updated_at) } : null;
  const complete = request?.status === 'completed' && Number(counts.analysis_count) > 0 && Number(counts.passage_count) > 0 && Number(counts.node_count) > 0;
  const active = request && ['created','awaiting-authorization','queued','running','applying-result'].includes(request.status);
  const failed = request && ['failed','timed-out','needs-review','cancelled'].includes(request.status);
  return {
    state: complete ? 'complete' : active ? 'processing' : failed ? 'failed' : request?.status === 'completed' ? 'incomplete' : 'not-started',
    ready: complete, transcriptRevisionId, request, nodeCount: Number(counts.node_count), edgeCount: Number(counts.edge_count), passageCount: Number(counts.passage_count),
    reason: complete ? null : active ? 'The current transcript is being indexed.' : failed ? request.failureSummary || 'The graph pipeline did not complete.' : request?.status === 'completed' ? 'The graph result is missing required knowledge or topic data.' : 'Build and review the graph for this transcript.',
  };
}

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

export function hydrateMissingEvidenceSpeakers(
  nodeRows: Record<string, unknown>[], evidenceRows: Record<string, unknown>[], transcriptByRevision: Map<string, string>,
) {
  const revisionByNode = new Map(nodeRows.map((row) => [String(row.id), String(row.source_transcript_revision_id)]));
  return evidenceRows.map((row) => {
    if (row.speaker != null && String(row.speaker).trim()) return row;
    const revisionId = revisionByNode.get(String(row.knowledge_node_id));
    const transcript = revisionId ? transcriptByRevision.get(revisionId) : null;
    const speaker = transcript ? speakerForTranscriptExcerpt(transcript, String(row.excerpt || '')) : null;
    return speaker ? { ...row, speaker } : row;
  });
}

export function listKnowledgeGraph(episodeId?: string, database: Database = db) {
  const where = episodeId ? ' WHERE episode_id = ?1' : '';
  const args = episodeId ? [episodeId] : [];
  const nodes = database.query(`SELECT * FROM knowledge_nodes${where} ORDER BY created_at ASC`).all(...args) as Record<string, unknown>[];
  if (!nodes.length) return { nodes: [], edges: [], snackLinks: [] };
  const nodeIds = new Set(nodes.map((row) => String(row.id)));
  const rawEvidence = (database.query(`SELECT evidence.* FROM knowledge_evidence evidence JOIN knowledge_nodes node ON node.id=evidence.knowledge_node_id${episodeId ? ' WHERE node.episode_id=?1' : ''} ORDER BY evidence.created_at ASC`).all(...args) as Record<string, unknown>[]).filter((row) => nodeIds.has(String(row.knowledge_node_id)));
  const revisionIds = [...new Set(nodes.map((row) => String(row.source_transcript_revision_id)))];
  const transcriptByRevision = new Map<string, string>();
  const transcriptQuery = database.query('SELECT transcript_text FROM transcript_revisions WHERE id = ?1');
  for (const revisionId of revisionIds) {
    const row = transcriptQuery.get(revisionId) as { transcript_text?: string } | null;
    if (row?.transcript_text) transcriptByRevision.set(revisionId, row.transcript_text);
  }
  const evidence = hydrateMissingEvidenceSpeakers(nodes, rawEvidence, transcriptByRevision);
  const edges = database.query(`SELECT * FROM knowledge_edges${where} ORDER BY created_at ASC`).all(...args) as Record<string, unknown>[];
  const links = database.query(`SELECT * FROM knowledge_snack_links${where} ORDER BY created_at ASC`).all(...args) as Record<string, unknown>[];
  return assembleKnowledgeGraph(nodes, evidence, edges, links);
}

export function listKnowledgeBackfill(database: Database = db) {
  const rows = database.query(`
    SELECT e.id,e.episode_number,e.working_title,e.active_transcript_revision_id,
      (SELECT pr.status FROM pipeline_requests pr
       WHERE pr.episode_id=e.id AND pr.pipeline_name='snack-studio-graph-relationships' AND pr.pipeline_version='7' AND pr.result_schema_version='5'
       ORDER BY pr.created_at DESC LIMIT 1) AS latest_status,
      (SELECT pr.attempt_count FROM pipeline_requests pr
       WHERE pr.episode_id=e.id AND pr.pipeline_name='snack-studio-graph-relationships' AND pr.pipeline_version='7' AND pr.result_schema_version='5'
       ORDER BY pr.created_at DESC LIMIT 1) AS latest_attempt_count
      ,(SELECT COUNT(*) FROM pipeline_requests active_pr
        WHERE active_pr.episode_id=e.id AND active_pr.pipeline_name='snack-studio-graph-relationships'
          AND active_pr.status IN ('created','awaiting-authorization','queued','running','applying-result')) AS active_graph_requests
    FROM episodes e
    WHERE e.active_transcript_revision_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM snack_candidates c WHERE c.episode_id=e.id AND c.review_decision='accepted')
    ORDER BY e.episode_number ASC
  `).all() as Record<string, unknown>[];
  const active = new Set(['created','awaiting-authorization','queued','running','applying-result']);
  return rows.map((row) => {
    const latestStatus = row.latest_status == null ? '' : String(row.latest_status); const attempts = Number(row.latest_attempt_count || 0); const anyGraphActive = Number(row.active_graph_requests || 0) > 0;
    const status = anyGraphActive ? 'processing' : !latestStatus ? 'not-started' : active.has(latestStatus) ? 'processing' : latestStatus === 'completed' ? 'complete' : ['failed','timed-out'].includes(latestStatus) && attempts < 2 ? 'retryable' : 'failed';
    return { episodeId: String(row.id), episodeNumber: row.episode_number == null ? null : Number(row.episode_number), title: String(row.working_title), transcriptRevisionId: String(row.active_transcript_revision_id), status };
  });
}
