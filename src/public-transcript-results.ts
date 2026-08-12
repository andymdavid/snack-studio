import type { Database } from 'bun:sqlite';
import { db as appDb } from './db.ts';
import { getPipelineRequest, getPipelineRun } from './pipeline-requests.ts';
import type { SuccessfulPublicTranscriptResult } from './public-transcript-result-input.ts';

export function applySuccessfulPublicTranscriptResult(input: { localRunId: string; result: SuccessfulPublicTranscriptResult }, database: Database = appDb) {
  const request = getPipelineRequest(input.result.requestId, database); const run = getPipelineRun(input.localRunId, database);
  if (!request || !run || run.requestId !== request.id) throw new Error('pipeline callback target not found');
  if (request.operation !== 'transcript-normalization' || request.episodeId !== input.result.episodeId) throw new Error('pipeline callback target mismatch');
  if (request.inputTranscriptRevisionId !== input.result.inputRevisionId) throw new Error('pipeline callback transcript revision mismatch');
  if (request.resultSchemaVersion !== input.result.resultSchemaVersion) throw new Error('pipeline callback result schema mismatch');
  const existing = database.query('SELECT id FROM public_transcripts WHERE pipeline_request_id = ?1').get(request.id) as { id: string } | null;
  if (existing) return { replay: true, publicTranscriptId: existing.id };
  const id = crypto.randomUUID(); const now = Date.now();
  database.transaction(() => {
    database.query(`INSERT INTO public_transcripts(id, episode_id, source_transcript_revision_id, transcript_text, cleanup_summary_json, status, pipeline_request_id, pipeline_run_id, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 'proposed', ?6, ?7, ?8, ?8)`).run(id, request.episodeId, request.inputTranscriptRevisionId, input.result.transcriptText, JSON.stringify(input.result.cleanupSummary), request.id, run.id, now);
    database.query("UPDATE pipeline_runs SET status = 'complete', progress_percent = 100, progress_label = 'Public transcript ready', completed_at = ?1, updated_at = ?1 WHERE id = ?2").run(now, run.id);
    database.query("UPDATE pipeline_requests SET status = 'completed', pipeline_version = ?1, result_applied_at = ?2, failure_summary = NULL, updated_at = ?2 WHERE id = ?3").run(input.result.pipelineVersion, now, request.id);
  })();
  return { replay: false, publicTranscriptId: id };
}
