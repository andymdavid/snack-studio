import { existsSync, mkdirSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { db } from './db.ts';
import { CONTRIBUTOR_UPLOAD_DIR } from './config.ts';
import { getContributor } from './contributors.ts';
import { getCurrentAutopilotTarget } from './db.ts';
import { recordAuditEvent } from './episodes.ts';

const PROMPT_VERSION = 'v3-contributor-identity-locked-voxel';
const STYLE_REFERENCES = [
  resolve('public/images/contributors/pete-winn-voxel.webp'),
  resolve('public/images/contributors/andy-david-voxel.webp'),
];
const PIPELINE_VERSION = 3;

function tokenHash(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)));
}

export type ContributorPortraitCandidate = {
  id: string; jobId: string; candidateNumber: number; status: string; previewUrl: string;
  promptText: string; modelName: string | null; mimeType: string; width: number; height: number; sizeBytes: number; createdAt: number;
};

export type ContributorPortraitJob = {
  id: string; contributorId: string; status: string; autopilotRunId: string | null; failureSummary: string | null;
  promptVersion: string; modelName: string | null; createdAt: number; updatedAt: number; candidates: ContributorPortraitCandidate[];
};

function mapCandidate(row: Record<string, unknown>): ContributorPortraitCandidate {
  const id = String(row.id);
  return {
    id, jobId: String(row.job_id), candidateNumber: Number(row.candidate_number), status: String(row.status),
    previewUrl: `/api/contributor-portrait-candidates/${encodeURIComponent(id)}/image`, promptText: String(row.prompt_text),
    modelName: row.model_name == null ? null : String(row.model_name), mimeType: String(row.mime_type),
    width: Number(row.width), height: Number(row.height), sizeBytes: Number(row.size_bytes), createdAt: Number(row.created_at),
  };
}

export function getPortraitCandidate(id: string) {
  return db.query('SELECT * FROM contributor_portrait_candidates WHERE id = ?1').get(id) as Record<string, unknown> | null;
}

export function listPortraitJobs(contributorId: string): ContributorPortraitJob[] {
  const rows = db.query('SELECT * FROM contributor_portrait_jobs WHERE contributor_id = ?1 ORDER BY created_at DESC').all(contributorId) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id), contributorId: String(row.contributor_id), status: String(row.status),
    autopilotRunId: row.autopilot_run_id == null ? null : String(row.autopilot_run_id),
    failureSummary: row.failure_summary == null ? null : String(row.failure_summary), promptVersion: String(row.prompt_version),
    modelName: row.model_name == null ? null : String(row.model_name), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    candidates: (db.query('SELECT * FROM contributor_portrait_candidates WHERE job_id = ?1 ORDER BY candidate_number').all(String(row.id)) as Record<string, unknown>[]).map(mapCandidate),
  }));
}

export function createPortraitJob(contributorId: string, actorPubkey: string, publicOrigin: string) {
  const contributor = getContributor(contributorId);
  if (!contributor?.referencePhotoPath || !existsSync(contributor.referencePhotoPath)) throw new Error('Contributor identity photo is required');
  if (STYLE_REFERENCES.some((path) => !existsSync(path))) throw new Error('Canonical portrait style references are unavailable');
  const id = crypto.randomUUID();
  const token = `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
  const now = Date.now();
  const outputDirectory = resolve(join(CONTRIBUTOR_UPLOAD_DIR, contributor.id, 'portrait-candidates', id));
  mkdirSync(outputDirectory, { recursive: true });
  db.transaction(() => {
    db.query(`INSERT INTO contributor_portrait_jobs(id, contributor_id, status, callback_token_hash, prompt_version, created_by_pubkey, created_at, updated_at)
      VALUES (?1, ?2, 'prepared', ?3, ?4, ?5, ?6, ?6)`).run(id, contributor.id, tokenHash(token), PROMPT_VERSION, actorPubkey, now);
    db.query("UPDATE contributors SET portrait_status = 'generating', updated_at = ?1 WHERE id = ?2").run(now, contributor.id);
    recordAuditEvent({ actorPubkey, action: 'contributor.portrait.started', entityType: 'contributor', entityId: contributor.id, detail: { jobId: id, promptVersion: PROMPT_VERSION } });
  })();
  const target = getCurrentAutopilotTarget();
  const origin = publicOrigin.replace(/\/$/, '');
  const input = {
    source: 'snack-studio', operation: 'contributor-portrait', jobId: id, contributorId: contributor.id,
    contributorName: contributor.name, identityReferencePath: resolve(contributor.referencePhotoPath),
    styleReferencePaths: STYLE_REFERENCES, outputDirectory, promptVersion: PROMPT_VERSION,
    webhook: { url: `${origin}/api/contributor-portrait-webhooks/${id}`, token, authHeader: 'x-snack-studio-token' },
    agent: 'codex',
  };
  return {
    job: listPortraitJobs(contributor.id)[0],
    triggerRequest: { url: new URL(`/api/pipelines/triggers/http/snack-studio-contributor-portrait.v${PIPELINE_VERSION}`, target.url).toString(), method: 'POST', body: { input } },
  };
}

function imageDimensions(path: string): { width: number; height: number } {
  const result = Bun.spawnSync(['identify', '-format', '%w %h', path]);
  if (result.exitCode !== 0) throw new Error('Generated portrait candidate is not a readable image');
  const [width, height] = result.stdout.toString().trim().split(/\s+/).map(Number);
  if (!width || !height || width !== height || width < 768) throw new Error('Generated portrait candidates must be square and at least 768 pixels');
  return { width, height };
}

export function markPortraitJobStarted(jobId: string, autopilotRunId: string) {
  const now = Date.now();
  db.query("UPDATE contributor_portrait_jobs SET status = 'running', autopilot_run_id = ?1, updated_at = ?2 WHERE id = ?3").run(autopilotRunId, now, jobId);
}

export function verifyPortraitTrigger(jobId: string, trigger: Record<string, unknown>) {
  const row = db.query('SELECT callback_token_hash FROM contributor_portrait_jobs WHERE id=?1').get(jobId) as { callback_token_hash: string } | null;
  const body = trigger.body && typeof trigger.body === 'object' ? trigger.body as Record<string, unknown> : {};
  const input = body.input && typeof body.input === 'object' ? body.input as Record<string, unknown> : {};
  const webhook = input.webhook && typeof input.webhook === 'object' ? input.webhook as Record<string, unknown> : {};
  let url: URL; try { url = new URL(String(trigger.url || '')); } catch { return false; }
  const target = getCurrentAutopilotTarget();
  return Boolean(row && String(trigger.method) === 'POST' && input.jobId === jobId
    && url.origin === new URL(target.url).origin && url.pathname.endsWith(`/snack-studio-contributor-portrait.v${PIPELINE_VERSION}`)
    && tokenHash(String(webhook.token || '')) === row.callback_token_hash);
}

function safeCandidatePath(jobId: string, value: string): string {
  const base = resolve(join(CONTRIBUTOR_UPLOAD_DIR));
  const candidate = resolve(normalize(value));
  if (!candidate.startsWith(`${base}/`) || !candidate.includes(`/portrait-candidates/${jobId}/`)) throw new Error('Candidate path is outside the portrait job directory');
  if (!existsSync(candidate)) throw new Error('Generated portrait candidate is missing');
  return candidate;
}

export function applyPortraitResult(jobId: string, token: string, body: Record<string, unknown>) {
  const job = db.query('SELECT * FROM contributor_portrait_jobs WHERE id = ?1').get(jobId) as Record<string, unknown> | null;
  if (!job || String(job.callback_token_hash) !== tokenHash(token)) throw new Error('Invalid portrait callback');
  if (body.status !== 'ok') {
    const summary = String(body.error || 'Portrait generation failed').slice(0, 1000);
    db.transaction(() => {
      db.query("UPDATE contributor_portrait_jobs SET status = 'failed', failure_summary = ?1, updated_at = ?2 WHERE id = ?3").run(summary, Date.now(), jobId);
      db.query("UPDATE contributors SET portrait_status = 'failed', updated_at = ?1 WHERE id = ?2").run(Date.now(), String(job.contributor_id));
    })();
    return;
  }
  const result = body.response && typeof body.response === 'object' ? body.response as Record<string, unknown> : body;
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  if (candidates.length < 1 || candidates.length > 3) throw new Error('Portrait result must contain one to three candidates');
  const now = Date.now();
  db.transaction(() => {
    for (const [index, raw] of candidates.entries()) {
      const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const path = safeCandidatePath(jobId, String(item.path || ''));
      const dimensions = imageDimensions(path);
      const mimeType = String(item.mimeType || (extname(path).toLowerCase() === '.webp' ? 'image/webp' : 'image/png'));
      db.query(`INSERT OR IGNORE INTO contributor_portrait_candidates(id, job_id, candidate_number, storage_path, prompt_text, model_name, mime_type, width, height, size_bytes, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`)
        .run(crypto.randomUUID(), jobId, index + 1, path, String(result.prompt || ''), String(result.model || ''), mimeType,
          dimensions.width, dimensions.height, statSync(path).size, now);
    }
    db.query("UPDATE contributor_portrait_jobs SET status = 'in-review', model_name = ?1, updated_at = ?2 WHERE id = ?3").run(String(result.model || ''), now, jobId);
    db.query("UPDATE contributors SET portrait_status = 'in-review', updated_at = ?1 WHERE id = ?2").run(now, String(job.contributor_id));
  })();
}

export function approvePortraitCandidate(candidateId: string, actorPubkey: string) {
  const row = db.query(`SELECT c.*, j.contributor_id FROM contributor_portrait_candidates c JOIN contributor_portrait_jobs j ON j.id = c.job_id WHERE c.id = ?1`).get(candidateId) as Record<string, unknown> | null;
  if (!row) throw new Error('Portrait candidate not found');
  const contributorId = String(row.contributor_id);
  const publicDirectory = resolve('public/images/contributors/generated');
  mkdirSync(publicDirectory, { recursive: true });
  const destination = join(publicDirectory, `${contributorId}-voxel.webp`);
  const conversion = Bun.spawnSync(['magick', String(row.storage_path), '-resize', '1024x1024^', '-gravity', 'center', '-extent', '1024x1024', '-strip', '-quality', '84', destination]);
  if (conversion.exitCode !== 0) throw new Error('Approved portrait could not be converted to the canonical WebP asset');
  const publicPath = `/images/contributors/generated/${contributorId}-voxel.webp`;
  const now = Date.now();
  db.transaction(() => {
    db.query("UPDATE contributor_portrait_candidates SET status = CASE WHEN id = ?1 THEN 'approved' ELSE 'rejected' END WHERE job_id = ?2").run(candidateId, String(row.job_id));
    db.query("UPDATE contributor_portrait_jobs SET status = 'approved', updated_at = ?1 WHERE id = ?2").run(now, String(row.job_id));
    db.query("UPDATE contributors SET portrait_path = ?1, portrait_status = 'approved', updated_at = ?2 WHERE id = ?3").run(publicPath, now, contributorId);
    recordAuditEvent({ actorPubkey, action: 'contributor.portrait.approved', entityType: 'contributor', entityId: contributorId, detail: { candidateId, publicPath } });
  })();
  return getContributor(contributorId)!;
}
