import { createRelationship } from './curation.ts';
import { getPipelineRequest, getPipelineRun } from './pipeline-requests.ts';
import { db } from './db.ts';
import type { SuccessfulGraphResult } from './graph-result-input.ts';
export function applySuccessfulGraphResult(input: { localRunId: string; result: SuccessfulGraphResult }) {
  const request = getPipelineRequest(input.result.requestId); const run = getPipelineRun(input.localRunId); if (!request || !run) throw new Error('pipeline callback target not found');
  if (request.episodeId !== input.result.episodeId || request.inputTranscriptRevisionId !== input.result.inputRevisionId || request.resultSchemaVersion !== '3') throw new Error('graph callback target mismatch');
  let count = 0; for (const suggestion of input.result.suggestions) { const source = db.query('SELECT episode_id FROM snack_candidates WHERE id=?1').get(suggestion.sourceCandidateId) as { episode_id: string } | null; if (!source || source.episode_id !== request.episodeId) throw new Error('graph suggestion source mismatch');
    try { createRelationship({ episodeId: request.episodeId, sourceCandidateId: suggestion.sourceCandidateId, targetCandidateId: suggestion.targetCandidateId, relationshipType: suggestion.relationshipType, explanation: suggestion.explanation.slice(0, 1000), evidenceExcerpt: suggestion.evidence.slice(0, 2000), origin: 'pipeline', reviewState: 'draft', actorPubkey: request.actorPubkey }); count++; } catch (error) { if (!(error instanceof Error && error.message.includes('UNIQUE'))) throw error; } }
  const now = Date.now();
  db.query("INSERT INTO pipeline_artifacts(id,request_id,run_id,artifact_type,schema_version,content_json,created_at) VALUES(?1,?2,?3,'graph-suggestions','3',?4,?5)").run(crypto.randomUUID(), request.id, run.id, JSON.stringify({ suggestions: input.result.suggestions }), now);
  db.query("UPDATE pipeline_runs SET status='complete',progress_percent=100,progress_label='Relationship suggestions ready',completed_at=?1,updated_at=?1 WHERE id=?2").run(now, run.id); db.query("UPDATE pipeline_requests SET status='completed',pipeline_version=?1,result_applied_at=?2,updated_at=?2 WHERE id=?3").run(input.result.pipelineVersion, now, request.id); return { suggestionCount: count };
}
