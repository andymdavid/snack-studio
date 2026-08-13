import { db } from './db.ts';

export type DiagnosticItem = {
  id: string;
  kind: 'pipeline' | 'thumbnail' | 'portrait';
  episodeId: string | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
  contributorId: string | null;
  contributorName: string | null;
  label: string;
  status: string;
  failureSummary: string | null;
  remoteRunId: string | null;
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
};

export function listDiagnostics(): DiagnosticItem[] {
  const pipelines = (db.query(`
    SELECT p.id, p.episode_id, e.episode_number, COALESCE(e.public_title,e.working_title) episode_title,
      p.operation label, p.status, p.failure_summary, p.attempt_count, p.created_at, p.updated_at,
      (SELECT r.autopilot_run_id FROM pipeline_runs r WHERE r.request_id=p.id ORDER BY r.attempt_number DESC LIMIT 1) remote_run_id
    FROM pipeline_requests p JOIN episodes e ON e.id=p.episode_id
  `).all() as Record<string, unknown>[]).map((row) => mapItem(row, 'pipeline'));
  const thumbnails = (db.query(`
    SELECT j.id,j.episode_id,e.episode_number,COALESCE(e.public_title,e.working_title) episode_title,
      CASE j.asset_kind WHEN 'episode' THEN 'Episode thumbnail' ELSE 'Snack thumbnail' END label,
      j.status,j.failure_summary,COALESCE(j.generation_round,0) attempt_count,j.created_at,j.updated_at,j.autopilot_run_id remote_run_id
    FROM thumbnail_jobs j JOIN episodes e ON e.id=j.episode_id
  `).all() as Record<string, unknown>[]).map((row) => mapItem(row, 'thumbnail'));
  const portraits = (db.query(`
    SELECT j.id,j.contributor_id,c.name contributor_name,'Contributor portrait' label,j.status,j.failure_summary,
      1 attempt_count,j.created_at,j.updated_at,j.autopilot_run_id remote_run_id
    FROM contributor_portrait_jobs j JOIN contributors c ON c.id=j.contributor_id
  `).all() as Record<string, unknown>[]).map((row) => mapItem(row, 'portrait'));
  return [...pipelines, ...thumbnails, ...portraits].sort((a, b) => b.updatedAt - a.updatedAt);
}

function mapItem(row: Record<string, unknown>, kind: DiagnosticItem['kind']): DiagnosticItem {
  return {
    id: String(row.id), kind, episodeId: row.episode_id == null ? null : String(row.episode_id),
    episodeNumber: row.episode_number == null ? null : Number(row.episode_number),
    episodeTitle: row.episode_title == null ? null : String(row.episode_title),
    contributorId: row.contributor_id == null ? null : String(row.contributor_id),
    contributorName: row.contributor_name == null ? null : String(row.contributor_name), label: String(row.label),
    status: String(row.status), failureSummary: row.failure_summary == null ? null : String(row.failure_summary),
    remoteRunId: row.remote_run_id == null ? null : String(row.remote_run_id), attemptCount: Number(row.attempt_count || 0),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}
