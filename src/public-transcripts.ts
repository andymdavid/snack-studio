import type { Database } from 'bun:sqlite';
import { db as appDb } from './db.ts';
import { recordAuditEvent } from './episodes.ts';

export type PublicTranscript = {
  id: string; episodeId: string; sourceTranscriptRevisionId: string; transcriptText: string;
  cleanupSummary: string[]; status: 'proposed' | 'approved' | 'rejected';
  pipelineRequestId: string | null; pipelineRunId: string | null;
  approvedAt: number | null; createdAt: number; updatedAt: number;
};

function map(row: Record<string, unknown>): PublicTranscript {
  let cleanupSummary: string[] = [];
  try { cleanupSummary = JSON.parse(String(row.cleanup_summary_json || '[]')); } catch {}
  return { id: String(row.id), episodeId: String(row.episode_id), sourceTranscriptRevisionId: String(row.source_transcript_revision_id),
    transcriptText: String(row.transcript_text), cleanupSummary, status: String(row.status) as PublicTranscript['status'],
    pipelineRequestId: row.pipeline_request_id == null ? null : String(row.pipeline_request_id), pipelineRunId: row.pipeline_run_id == null ? null : String(row.pipeline_run_id),
    approvedAt: row.approved_at == null ? null : Number(row.approved_at), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}

export function getLatestPublicTranscript(episodeId: string, database: Database = appDb): PublicTranscript | null {
  const row = database.query('SELECT * FROM public_transcripts WHERE episode_id = ?1 ORDER BY created_at DESC LIMIT 1').get(episodeId) as Record<string, unknown> | null;
  return row ? map(row) : null;
}

export function getApprovedPublicTranscript(episodeId: string, database: Database = appDb): PublicTranscript | null {
  const row = database.query("SELECT * FROM public_transcripts WHERE episode_id = ?1 AND status = 'approved' ORDER BY approved_at DESC LIMIT 1").get(episodeId) as Record<string, unknown> | null;
  return row ? map(row) : null;
}

export function reviewPublicTranscript(input: { id: string; status: 'approved' | 'rejected'; transcriptText?: string; actorPubkey: string }, database: Database = appDb) {
  const row = database.query('SELECT * FROM public_transcripts WHERE id = ?1').get(input.id) as Record<string, unknown> | null;
  if (!row) throw new Error('public transcript not found');
  const transcriptText = (input.transcriptText ?? String(row.transcript_text)).trim();
  if (input.status === 'approved' && transcriptText.length < 100) throw new Error('public transcript is too short');
  const now = Date.now();
  database.transaction(() => {
    if (input.status === 'approved') database.query("UPDATE public_transcripts SET status = 'rejected', updated_at = ?1 WHERE episode_id = ?2 AND id <> ?3 AND status = 'approved'").run(now, String(row.episode_id), input.id);
    database.query('UPDATE public_transcripts SET transcript_text = ?1, status = ?2, approved_by_pubkey = ?3, approved_at = ?4, updated_at = ?5 WHERE id = ?6')
      .run(transcriptText, input.status, input.status === 'approved' ? input.actorPubkey : null, input.status === 'approved' ? now : null, now, input.id);
    if (database === appDb) recordAuditEvent({ actorPubkey: input.actorPubkey, action: `public-transcript.${input.status}`, entityType: 'episode', entityId: String(row.episode_id), detail: { publicTranscriptId: input.id } });
  })();
  return getLatestPublicTranscript(String(row.episode_id), database)!;
}
