import type { Database } from 'bun:sqlite';
import { db as appDb } from './db.ts';
import { getPipelineRequest, getPipelineRequestTranscript, getPipelineRun } from './pipeline-requests.ts';
import { normalizeThemeEvidence } from './theme-results.ts';
import type { SuccessfulKnowledgeResult } from './knowledge-result-input.ts';

export function applySuccessfulKnowledgeResult(input: { localRunId: string; result: SuccessfulKnowledgeResult }, database: Database = appDb) {
  const request = getPipelineRequest(input.result.requestId, database); const run = getPipelineRun(input.localRunId, database);
  if (!request || !run || run.requestId !== request.id) throw new Error('pipeline callback target not found');
  if (request.status === 'completed' && request.resultAppliedAt) return { replay: true, nodeCount: input.result.nodes.length };
  if (request.operation !== 'publication-metadata' || request.episodeId !== input.result.episodeId || request.inputTranscriptRevisionId !== input.result.inputRevisionId || request.resultSchemaVersion !== '4') throw new Error('knowledge callback provenance mismatch');
  const transcript = getPipelineRequestTranscript(request.id, database); if (!transcript) throw new Error('pipeline transcript unavailable');
  const source = normalizeThemeEvidence(transcript.transcriptText);
  for (const node of input.result.nodes) for (const evidence of node.evidence) if (!source.includes(normalizeThemeEvidence(evidence.excerpt))) throw new Error(`Knowledge node ${node.key} evidence is not an exact transcript excerpt`);
  const approvedCandidates = new Set((database.query("SELECT id FROM snack_candidates WHERE episode_id=?1 AND review_decision='accepted'").all(request.episodeId) as Array<{ id: string }>).map((row) => row.id));
  for (const link of input.result.snackLinks) if (!approvedCandidates.has(link.candidateId)) throw new Error('Knowledge link does not target an accepted Snack from this episode');
  const now = Date.now(); const idByKey = new Map(input.result.nodes.map((node) => [node.key, crypto.randomUUID()]));
  database.transaction(() => {
    database.query("DELETE FROM knowledge_nodes WHERE episode_id=?1 AND source_transcript_revision_id=?2 AND origin='pipeline'").run(request.episodeId, request.inputTranscriptRevisionId);
    for (const node of input.result.nodes) {
      const id = idByKey.get(node.key)!; database.query(`INSERT INTO knowledge_nodes(id,episode_id,source_transcript_revision_id,kind,title,summary,confidence,review_state,origin,pipeline_request_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'accepted','pipeline',?8,?9,?9)`).run(id, request.episodeId, request.inputTranscriptRevisionId, node.kind, node.title, node.summary, node.confidence, request.id, now);
      for (const evidence of node.evidence) database.query('INSERT INTO knowledge_evidence(id,knowledge_node_id,excerpt,speaker,created_at) VALUES(?1,?2,?3,?4,?5)').run(crypto.randomUUID(), id, evidence.excerpt, evidence.speaker, now);
    }
    for (const edge of input.result.edges) database.query(`INSERT INTO knowledge_edges(id,episode_id,source_node_id,target_node_id,relationship_type,explanation,confidence,review_state,origin,pipeline_request_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'accepted','pipeline',?8,?9,?9)`).run(crypto.randomUUID(), request.episodeId, idByKey.get(edge.sourceKey)!, idByKey.get(edge.targetKey)!, edge.relationshipType, edge.explanation, edge.confidence, request.id, now);
    for (const link of input.result.snackLinks) database.query(`INSERT INTO knowledge_snack_links(id,episode_id,knowledge_node_id,candidate_id,relationship_type,confidence,review_state,origin,pipeline_request_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'accepted','pipeline',?7,?8,?8)`).run(crypto.randomUUID(), request.episodeId, idByKey.get(link.nodeKey)!, link.candidateId, link.relationshipType, link.confidence, request.id, now);
    database.query("INSERT INTO pipeline_artifacts(id,request_id,run_id,artifact_type,schema_version,content_json,created_at) VALUES(?1,?2,?3,'transcript-knowledge','4',?4,?5)").run(crypto.randomUUID(), request.id, run.id, JSON.stringify({ nodeCount: input.result.nodes.length, edgeCount: input.result.edges.length, snackLinkCount: input.result.snackLinks.length }), now);
    database.query("UPDATE pipeline_runs SET status='complete',progress_percent=100,progress_label='Knowledge graph ready',completed_at=?1,updated_at=?1 WHERE id=?2").run(now, run.id);
    database.query("UPDATE pipeline_requests SET status='completed',pipeline_version=COALESCE(?1,pipeline_version),result_applied_at=?2,failure_summary=NULL,updated_at=?2 WHERE id=?3").run(input.result.pipelineVersion, now, request.id);
  })();
  return { replay: false, nodeCount: input.result.nodes.length, edgeCount: input.result.edges.length, snackLinkCount: input.result.snackLinks.length };
}
