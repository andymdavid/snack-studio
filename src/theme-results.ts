import type { Database } from 'bun:sqlite';
import { db as appDb } from './db.ts';
import { getPipelineRequest, getPipelineRequestTranscript, getPipelineRun } from './pipeline-requests.ts';
import { createTheme, getTheme } from './themes.ts';
import type { SuccessfulThemeResult } from './theme-result-input.ts';

function normalize(value: string) { return value.replace(/\s+/g, ' ').trim().toLowerCase(); }

export function applySuccessfulThemeResult(input: { localRunId: string; result: SuccessfulThemeResult }, database: Database = appDb) {
  const request = getPipelineRequest(input.result.requestId, database); const run = getPipelineRun(input.localRunId, database);
  if (!request || !run || run.requestId !== request.id) throw new Error('pipeline callback target not found');
  if (request.status === 'completed' && request.resultAppliedAt) return { replay: true, assignmentCount: input.result.snackAssignments.length };
  if (request.operation !== 'publication-metadata' || request.episodeId !== input.result.episodeId || request.inputTranscriptRevisionId !== input.result.inputRevisionId || request.resultSchemaVersion !== input.result.resultSchemaVersion) throw new Error('pipeline callback provenance mismatch');
  const transcript = getPipelineRequestTranscript(request.id, database); if (!transcript) throw new Error('pipeline transcript unavailable');
  const source = normalize(transcript.transcriptText);
  for (const theme of input.result.episodeThemes) if (!source.includes(normalize(theme.evidenceExcerpt))) throw new Error(`Theme ${theme.key} evidence is not an exact transcript excerpt`);
  const approved = database.query(`SELECT c.id candidate_id,c.current_revision_id FROM snack_candidates c WHERE c.episode_id=?1 AND c.review_decision='accepted' ORDER BY c.approved_position`).all(request.episodeId) as Array<{ candidate_id: string; current_revision_id: string }>;
  const expected = new Map(approved.map((row) => [row.candidate_id, row.current_revision_id]));
  if (approved.length !== input.result.snackAssignments.length) throw new Error('theme assignments must cover the complete approved Snack set');
  for (const item of input.result.snackAssignments) if (expected.get(item.candidateId) !== item.revisionId) throw new Error('theme assignment does not match the approved Snack revision');
  const now = Date.now();
  database.transaction(() => {
    const keyToTheme = new Map<string, ReturnType<typeof getTheme>>();
    for (const theme of input.result.episodeThemes) {
      const resolved = theme.existingThemeId ? getTheme(theme.existingThemeId, database) : createTheme({ name: theme.name, description: theme.description }, database);
      if (!resolved) throw new Error(`Could not resolve theme ${theme.key}`); keyToTheme.set(theme.key, resolved);
    }
    database.query('DELETE FROM episode_theme_assignments WHERE episode_id=?1').run(request.episodeId);
    for (const theme of input.result.episodeThemes) database.query('INSERT INTO episode_theme_assignments(episode_id,theme_id,rationale,evidence_excerpt,pipeline_request_id,created_at) VALUES(?1,?2,?3,?4,?5,?6)')
      .run(request.episodeId, keyToTheme.get(theme.key)!.id, theme.rationale, theme.evidenceExcerpt, request.id, now);
    for (const item of input.result.snackAssignments) {
      database.query('DELETE FROM snack_theme_assignments WHERE snack_revision_id=?1').run(item.revisionId);
      for (const key of item.themeKeys) database.query('INSERT INTO snack_theme_assignments(snack_revision_id,candidate_id,episode_id,theme_id,visual_theme,rationale,pipeline_request_id,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)')
        .run(item.revisionId, item.candidateId, request.episodeId, keyToTheme.get(key)!.id, key === item.visualThemeKey ? 1 : 0, item.rationale, request.id, now);
      const visual = keyToTheme.get(item.visualThemeKey)!;
      database.query('UPDATE thumbnail_jobs SET topic_colour=?1,updated_at=?2 WHERE snack_revision_id=?3').run(visual.colour, now, item.revisionId);
    }
    database.query("UPDATE pipeline_runs SET status='complete',progress_percent=100,progress_label='Themes ready',completed_at=?1,updated_at=?1 WHERE id=?2").run(now, run.id);
    database.query("UPDATE pipeline_requests SET status='completed',pipeline_version=COALESCE(?1,pipeline_version),result_applied_at=?2,failure_summary=NULL,updated_at=?2 WHERE id=?3").run(input.result.pipelineVersion, now, request.id);
  })();
  return { replay: false, assignmentCount: input.result.snackAssignments.length };
}
