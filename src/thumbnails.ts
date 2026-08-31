import { db } from "./db.ts";
import { getCandidate, validateApprovedCandidateBatch } from "./candidates.ts";
import { getActiveTranscriptRevision, getEpisode, recordAuditEvent } from "./episodes.ts";
import type { ThumbnailAssetKind, ThumbnailBriefInput } from "./thumbnail-input.ts";
import { resolveTranscriptParticipants } from "./publication-metadata.ts";
import { getTheme } from './themes.ts';
import { getContributor } from "./contributors.ts";
import { bytesToHex } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join, normalize, extname } from 'node:path';
import { CONTRIBUTOR_UPLOAD_DIR } from './config.ts';
import { getCurrentAutopilotTarget } from './db.ts';

export type ThumbnailJobStatus = "draft" | "extracting" | "grounding" | "generating" | "in-review" | "approved" | "failed";

const EPISODE_THUMBNAIL_PIPELINE_VERSION = '10';
const SNACK_THUMBNAIL_PIPELINE_VERSION = '4';
const EPISODE_THUMBNAIL_GUEST_REFERENCE = resolve('public/images/references/episode-thumbnail-guest-canonical.png');
const EPISODE_THUMBNAIL_TWO_HOST_REFERENCE = resolve('public/images/references/episode-thumbnail-two-host-canonical.png');
const EPISODE_THUMBNAIL_TWO_HOST_FOREGROUND = resolve('public/images/references/episode-thumbnail-two-host-foreground-v1.png');

export function thumbnailPipelineRoute(assetKind: ThumbnailAssetKind) {
  const pipeline = assetKind === 'episode' ? 'snack-studio-episode-thumbnail' : 'snack-studio-snack-thumbnail';
  const version = assetKind === 'episode' ? EPISODE_THUMBNAIL_PIPELINE_VERSION : SNACK_THUMBNAIL_PIPELINE_VERSION;
  return { pipeline, version, path: `/snack-studio-${assetKind}-thumbnail.v${version}` };
}

export function episodeThumbnailTemplate(contributorIds: string[]) {
  return contributorIds.some((id) => !['pete-winn', 'andy-david'].includes(id))
    ? 'two-hosts-plus-guest'
    : 'two-hosts';
}

export function episodeTitleAccentY(template: 'two-hosts' | 'two-hosts-plus-guest', leadY: number, leadHeight: number) {
  return template === 'two-hosts-plus-guest' ? leadY + leadHeight + 28 : 335;
}

function currentTranscriptContributorIds(transcriptText: string) {
  const participants = resolveTranscriptParticipants(transcriptText);
  if (participants.unresolved.length) {
    throw new Error(`Resolve transcript contributors before generating thumbnails: ${participants.unresolved.join(', ')}`);
  }
  const contributorIds = [...new Set(participants.resolved.map(({ contributorId }) => contributorId))];
  if (!contributorIds.length) throw new Error('No episode contributors could be resolved from the transcript');
  return contributorIds;
}

export type ThumbnailJob = {
  id: string;
  episodeId: string;
  assetKind: ThumbnailAssetKind;
  snackCandidateId: string | null;
  snackRevisionId: string | null;
  transcriptRevisionId: string;
  status: ThumbnailJobStatus;
  topicColour: string | null;
  contributorIds: string[];
  selectedCandidateId: string | null;
  reviewNotes: string | null;
  pipelineName: string | null;
  pipelineVersion: string | null;
  createdByPubkey: string;
  createdAt: number;
  updatedAt: number;
  autopilotRunId?: string | null;
  failureSummary?: string | null;
  generationRound?: number;
};

function parseStringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function mapThumbnailJob(row: Record<string, unknown>): ThumbnailJob {
  return {
    id: String(row.id),
    episodeId: String(row.episode_id),
    assetKind: String(row.asset_kind) as ThumbnailAssetKind,
    snackCandidateId: row.snack_candidate_id == null ? null : String(row.snack_candidate_id),
    snackRevisionId: row.snack_revision_id == null ? null : String(row.snack_revision_id),
    transcriptRevisionId: String(row.transcript_revision_id),
    status: String(row.status) as ThumbnailJobStatus,
    topicColour: row.topic_colour == null ? null : String(row.topic_colour),
    contributorIds: parseStringArray(row.contributor_ids_json),
    selectedCandidateId: row.selected_candidate_id == null ? null : String(row.selected_candidate_id),
    reviewNotes: row.review_notes == null ? null : String(row.review_notes),
    pipelineName: row.pipeline_name == null ? null : String(row.pipeline_name),
    pipelineVersion: row.pipeline_version == null ? null : String(row.pipeline_version),
    createdByPubkey: String(row.created_by_pubkey),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    autopilotRunId: row.autopilot_run_id == null ? null : String(row.autopilot_run_id),
    failureSummary: row.failure_summary == null ? null : String(row.failure_summary),
    generationRound: Number(row.generation_round || 0),
  };
}

function hashToken(value: string) { return bytesToHex(sha256(new TextEncoder().encode(value))); }

export function verifyThumbnailCallbackToken(jobId: string, token: string) {
  const row = db.query('SELECT callback_token_hash FROM thumbnail_jobs WHERE id=?1').get(jobId) as { callback_token_hash: string | null } | null;
  return Boolean(row?.callback_token_hash && token && hashToken(token) === row.callback_token_hash);
}

export function getThumbnailJobDetail(id: string) {
  const job = getThumbnailJob(id);
  if (!job) return null;
  const evidence = db.query('SELECT * FROM thumbnail_object_evidence WHERE job_id = ?1 ORDER BY created_at').all(id);
  const candidates = (db.query('SELECT * FROM thumbnail_candidates WHERE job_id = ?1 ORDER BY generation_round DESC, candidate_number').all(id) as Record<string, unknown>[])
    .map((row) => ({ id: String(row.id), generationRound: Number(row.generation_round), candidateNumber: Number(row.candidate_number),
      status: String(row.status), promptText: String(row.prompt_text), modelName: row.model_name == null ? null : String(row.model_name),
      width: Number(row.width), height: Number(row.height), previewUrl: `/api/thumbnail-candidates/${encodeURIComponent(String(row.id))}/image` }));
  return { ...job, evidence, candidates };
}

export function getThumbnailCandidateRow(id: string) {
  return db.query('SELECT * FROM thumbnail_candidates WHERE id = ?1').get(id) as Record<string, unknown> | null;
}

export function getThumbnailAssetRow(id: string) {
  return db.query('SELECT * FROM thumbnail_assets WHERE id = ?1').get(id) as Record<string, unknown> | null;
}

export function listFinishedThumbnailAssets() {
  return (db.query(`
    SELECT a.id, a.job_id, a.width, a.height, a.mime_type, a.size_bytes, a.version_number, a.created_at,
      j.episode_id, j.asset_kind, j.snack_candidate_id, j.topic_colour,
      e.episode_number, COALESCE(e.public_title, e.working_title) AS episode_title,
      r.public_title AS snack_title
    FROM thumbnail_assets a
    JOIN thumbnail_jobs j ON j.id = a.job_id
    JOIN episodes e ON e.id = j.episode_id
    LEFT JOIN snack_revisions r ON r.id = j.snack_revision_id
    WHERE a.asset_stage = 'finished'
    ORDER BY a.created_at DESC
  `).all() as Record<string, unknown>[]).map((row) => ({
    id: String(row.id), jobId: String(row.job_id), episodeId: String(row.episode_id),
    assetKind: String(row.asset_kind), snackCandidateId: row.snack_candidate_id == null ? null : String(row.snack_candidate_id),
    title: row.asset_kind === 'episode' ? String(row.episode_title) : String(row.snack_title || 'Untitled Snack'),
    episodeTitle: String(row.episode_title), episodeNumber: row.episode_number == null ? null : Number(row.episode_number),
    topicColour: row.topic_colour == null ? null : String(row.topic_colour), width: Number(row.width), height: Number(row.height),
    mimeType: String(row.mime_type), sizeBytes: Number(row.size_bytes), versionNumber: Number(row.version_number),
    createdAt: Number(row.created_at),
    imageUrl: `/api/assets/thumbnails/${encodeURIComponent(String(row.id))}/image`,
    libraryImageUrl: `/api/assets/thumbnails/${encodeURIComponent(String(row.id))}/library`,
  }));
}

export function createThumbnailGeneration(jobId: string, actorPubkey: string, publicOrigin: string, reviewNote?: string) {
  let job = getThumbnailJob(jobId);
  if (!job) throw new Error('Thumbnail job not found');
  if (job.assetKind === 'snack' && (!job.snackCandidateId || !job.topicColour)) throw new Error('Snack thumbnail context is incomplete');
  const candidate = job.snackCandidateId ? getCandidate(job.snackCandidateId) : null;
  const transcript = getActiveTranscriptRevision(job.episodeId);
  const episode = getEpisode(job.episodeId);
  if ((job.assetKind === 'snack' && !candidate) || !transcript || !episode) throw new Error('Thumbnail source context is incomplete');
  const contributorIds = currentTranscriptContributorIds(transcript.transcriptText);
  db.query('UPDATE thumbnail_jobs SET transcript_revision_id=?1, contributor_ids_json=?2, updated_at=?3 WHERE id=?4')
    .run(transcript.id, JSON.stringify(contributorIds), Date.now(), job.id);
  job = getThumbnailJob(job.id)!;
  const contributors = job.contributorIds.map(getContributor);
  if (contributors.some((item) => !item?.portraitPath || item.portraitStatus !== 'approved')) throw new Error('Every contributor needs an approved portrait');
  const round = Number(job.generationRound || 0) + 1;
  const targetedNote = String(reviewNote || '').trim().slice(0, 600);
  const outputDirectory = resolve(join(CONTRIBUTOR_UPLOAD_DIR, '..', 'thumbnails', job.id, `round-${round}`));
  mkdirSync(outputDirectory, { recursive: true });
  const contextPath = join(outputDirectory, 'context.json');
  const episodeTemplate = episodeThumbnailTemplate(job.contributorIds);
  const hasGuest = episodeTemplate === 'two-hosts-plus-guest';
  const episodeReference = hasGuest ? EPISODE_THUMBNAIL_GUEST_REFERENCE : EPISODE_THUMBNAIL_TWO_HOST_REFERENCE;
  writeFileSync(contextPath, JSON.stringify({
    jobId: job.id, assetKind: job.assetKind, snack: candidate?.revision || null, transcript: transcript.transcriptText, topicColour: job.topicColour,
    episode: { number: episode.episodeNumber, title: episode.publicTitle || episode.workingTitle },
    contributors: contributors.map((item) => ({ id: item!.id, name: item!.name, portraitPath: resolve(`public${item!.portraitPath}`) })),
    episodeTemplate: job.assetKind === 'episode' ? episodeTemplate : null,
    calibrationReferencePath: job.assetKind === 'episode' && existsSync(episodeReference) ? episodeReference : null,
    reviewNote: targetedNote || null,
  }, null, 2));
  const token = `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
  const { pipeline, version } = thumbnailPipelineRoute(job.assetKind);
  db.query("UPDATE thumbnail_jobs SET status=?1, callback_token_hash=?2, generation_round=?3, pipeline_name=?4, pipeline_version=?5, autopilot_run_id=NULL, failure_summary=NULL, updated_at=?6 WHERE id=?7")
    .run(job.assetKind === 'episode' ? 'generating' : 'extracting', hashToken(token), round, pipeline, version, Date.now(), job.id);
  if (targetedNote) db.query('UPDATE thumbnail_jobs SET review_notes=?1 WHERE id=?2').run(targetedNote, job.id);
  recordAuditEvent({ actorPubkey, action: 'thumbnail.generation.started', entityType: 'thumbnail-job', entityId: job.id, detail: { round } });
  const target = getCurrentAutopilotTarget();
  return {
    job: getThumbnailJob(job.id),
    triggerRequest: {
      url: new URL(`/api/pipelines/triggers/http/${pipeline}.v${version}`, target.url).toString(), method: 'POST',
      body: { input: { source: 'snack-studio', operation: job.assetKind === 'episode' ? 'episode-thumbnail' : 'snack-thumbnail', jobId: job.id, generationRound: round, contextPath, outputDirectory, agent: 'codex', webhook: { url: `${publicOrigin.replace(/\/$/, '')}/api/thumbnail-webhooks/${job.id}`, token, authHeader: 'x-snack-studio-token' } } },
    },
  };
}

export function markThumbnailGenerationStarted(jobId: string, runId: string) {
  db.query("UPDATE thumbnail_jobs SET status='generating', autopilot_run_id=?1, updated_at=?2 WHERE id=?3").run(runId, Date.now(), jobId);
}

export function verifyThumbnailGenerationTrigger(jobId: string, trigger: Record<string, unknown>) {
  const job = getThumbnailJob(jobId);
  if (!job) return false;
  const row = db.query('SELECT callback_token_hash FROM thumbnail_jobs WHERE id=?1').get(jobId) as { callback_token_hash: string | null } | null;
  const body = trigger.body && typeof trigger.body === 'object' ? trigger.body as Record<string, unknown> : {};
  const input = body.input && typeof body.input === 'object' ? body.input as Record<string, unknown> : {};
  const webhook = input.webhook && typeof input.webhook === 'object' ? input.webhook as Record<string, unknown> : {};
  let url: URL; try { url = new URL(String(trigger.url || '')); } catch { return false; }
  const target = getCurrentAutopilotTarget();
  const expected = thumbnailPipelineRoute(job.assetKind).path;
  return Boolean(row?.callback_token_hash && String(trigger.method) === 'POST' && input.jobId === jobId
    && url.origin === new URL(target.url).origin && url.pathname.endsWith(expected)
    && String(webhook.token || '') && hashToken(String(webhook.token)) === row.callback_token_hash);
}

export function markThumbnailGenerationFailed(jobId: string, summary: string) {
  db.query("UPDATE thumbnail_jobs SET status='failed', autopilot_run_id=NULL, failure_summary=?1, updated_at=?2 WHERE id=?3")
    .run(summary.slice(0, 1000), Date.now(), jobId);
}

function safeThumbnailPath(jobId: string, round: number, value: string) {
  const base = resolve(join(CONTRIBUTOR_UPLOAD_DIR, '..', 'thumbnails', jobId, `round-${round}`));
  const path = resolve(normalize(value));
  if (!path.startsWith(`${base}/`) || !existsSync(path)) throw new Error('Thumbnail candidate is outside its generation directory');
  return path;
}

function thumbnailDimensions(path: string, assetKind: ThumbnailAssetKind = 'snack') {
  const result = Bun.spawnSync(['identify', '-format', '%w %h', path]);
  if (result.exitCode !== 0) throw new Error('Generated thumbnail candidate is not a readable image');
  const [width, height] = result.stdout.toString().trim().split(/\s+/).map(Number);
  const targetRatio = assetKind === 'episode' ? 16 / 9 : 1.5;
  if (!width || !height || Math.abs(width / height - targetRatio) > 0.04 || width < 1200) throw new Error(`Thumbnail candidates must be ${assetKind === 'episode' ? '16:9' : '3:2'} and at least 1200 pixels wide`);
  return { width, height };
}

export function applyThumbnailResult(jobId: string, token: string, body: Record<string, unknown>) {
  const row = db.query('SELECT * FROM thumbnail_jobs WHERE id=?1').get(jobId) as Record<string, unknown> | null;
  if (!row || !verifyThumbnailCallbackToken(jobId, token)) throw new Error('Invalid thumbnail callback');
  const response = body.response && typeof body.response === 'object' ? body.response as Record<string, unknown> : body;
  const evidence = Array.isArray(response.evidence) ? response.evidence : [];
  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  const assetKind = String(row.asset_kind) as ThumbnailAssetKind;
  if (candidates.length !== 1) throw new Error('Thumbnail result requires one candidate');
  const round = Number(row.generation_round); const now = Date.now();
  db.transaction(() => {
    db.query('DELETE FROM thumbnail_object_evidence WHERE job_id=?1').run(jobId);
    for (const raw of evidence) {
      const item = raw as Record<string, unknown>;
      db.query(`INSERT INTO thumbnail_object_evidence(id,job_id,object_name,transcript_excerpt,timestamp_label,role_in_snack,grounding_status,grounding_rationale,created_at) VALUES(?1,?2,?3,?4,?5,?6,'approved',?7,?8)`)
        .run(crypto.randomUUID(), jobId, String(item.object || ''), String(item.evidence || ''), String(item.timestamp || ''), String(item.roleInSnack || ''), String(item.rationale || ''), now);
    }
    for (const [index, raw] of candidates.entries()) {
      const item = raw as Record<string, unknown>; let path = safeThumbnailPath(jobId, round, String(item.path || '')); let dimensions = thumbnailDimensions(path, assetKind);
      if (assetKind === 'episode') {
        const preview = join(resolve(path, '..'), 'candidate-1-finished.png');
        const finished = finishEpisodeThumbnail({ ...row, source_uri: path }, preview);
        if (finished.exitCode !== 0) throw new Error('Episode thumbnail preview could not be composed');
        path = preview; dimensions = thumbnailDimensions(path, 'episode');
      }
      db.query(`INSERT INTO thumbnail_candidates(id,job_id,generation_round,candidate_number,source_uri,prompt_text,model_name,width,height,mime_type,size_bytes,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`)
        .run(crypto.randomUUID(), jobId, round, index + 1, path, String(response.prompt || ''), String(response.model || ''), dimensions.width, dimensions.height, assetKind === 'episode' ? 'image/png' : String(item.mimeType || (extname(path)==='.webp'?'image/webp':'image/png')), statSync(path).size, now);
    }
    db.query("UPDATE thumbnail_jobs SET status='in-review', updated_at=?1 WHERE id=?2").run(now, jobId);
  })();
}

export function approveThumbnailCandidate(candidateId: string, actorPubkey: string) {
  const row = db.query(`SELECT c.*, j.episode_id, j.snack_candidate_id, j.asset_kind, j.contributor_ids_json FROM thumbnail_candidates c JOIN thumbnail_jobs j ON j.id=c.job_id WHERE c.id=?1`).get(candidateId) as Record<string, unknown> | null;
  if (!row) throw new Error('Thumbnail candidate not found');
  const jobId = String(row.job_id);
  const version = Number((db.query("SELECT COALESCE(MAX(version_number),0)+1 version FROM thumbnail_assets WHERE job_id=?1 AND asset_stage='finished'").get(jobId) as { version: number }).version);
  const directory = resolve(join(CONTRIBUTOR_UPLOAD_DIR, '..', 'thumbnails', jobId, 'finished'));
  mkdirSync(directory, { recursive: true });
  const isEpisode = String(row.asset_kind) === 'episode';
  const width = isEpisode ? 1672 : 1536; const height = isEpisode ? 941 : 1024;
  const destination = join(directory, `thumbnail-v${version}-master.png`);
  const conversion = Bun.spawnSync(['magick', String(row.source_uri), '-resize', `${width}x${height}^`, '-gravity', 'center', '-extent', `${width}x${height}`, '-strip', destination]);
  if (conversion.exitCode !== 0) throw new Error('Thumbnail candidate could not be finished');
  const libraryPath = join(directory, `thumbnail-v${version}-library.webp`);
  const websitePath = join(directory, `thumbnail-v${version}-website.webp`);
  createWebpDerivative(destination, libraryPath, 640, 76);
  createWebpDerivative(destination, websitePath, width, 84);
  const digest = bytesToHex(sha256(readFileSync(destination))); const now = Date.now();
  db.transaction(() => {
    db.query("UPDATE thumbnail_candidates SET status=CASE WHEN id=?1 THEN 'approved' ELSE 'rejected' END WHERE job_id=?2 AND generation_round=?3").run(candidateId, jobId, Number(row.generation_round));
    db.query(`INSERT INTO thumbnail_assets(id,job_id,candidate_id,asset_stage,storage_path,width,height,mime_type,size_bytes,sha256,version_number,created_at,library_storage_path,library_size_bytes,website_storage_path,website_size_bytes) VALUES(?1,?2,?3,'finished',?4,?5,?6,'image/png',?7,?8,?9,?10,?11,?12,?13,?14)`)
      .run(crypto.randomUUID(), jobId, candidateId, destination, width, height, statSync(destination).size, digest, version, now, libraryPath, statSync(libraryPath).size, websitePath, statSync(websitePath).size);
    db.query("UPDATE thumbnail_jobs SET status='approved', selected_candidate_id=?1, updated_at=?2 WHERE id=?3").run(candidateId, now, jobId);
    recordAuditEvent({ actorPubkey, action: 'thumbnail.candidate.approved', entityType: 'thumbnail-job', entityId: jobId, detail: { candidateId, version, sha256: digest } });
  })();
  return getThumbnailJobDetail(jobId)!;
}

function createWebpDerivative(sourcePath: string, destination: string, maxWidth: number, quality: number) {
  const conversion = Bun.spawnSync([
    'magick', sourcePath, '-resize', `${maxWidth}x>`, '-strip', '-quality', String(quality),
    '-define', 'webp:method=6', destination,
  ]);
  if (conversion.exitCode !== 0) throw new Error('Thumbnail WebP derivative could not be created');
}

export function ensureThumbnailAssetVariants(assetId: string) {
  let asset = getThumbnailAssetRow(assetId);
  if (!asset) return null;
  if (
    String(asset.mime_type) === 'image/png'
    && extname(String(asset.storage_path)).toLowerCase() === '.png'
    && asset.library_storage_path
    && asset.website_storage_path
    && existsSync(String(asset.storage_path))
    && existsSync(String(asset.library_storage_path))
    && existsSync(String(asset.website_storage_path))
  ) return asset;
  const version = Number(asset.version_number);
  const directory = dirname(String(asset.storage_path));
  let masterPath = String(asset.storage_path);
  if (String(asset.mime_type) !== 'image/png' || extname(masterPath).toLowerCase() !== '.png') {
    const normalizedMaster = join(directory, `thumbnail-v${version}-master.png`);
    if (!existsSync(normalizedMaster)) {
      const conversion = Bun.spawnSync(['magick', masterPath, '-strip', normalizedMaster]);
      if (conversion.exitCode !== 0) throw new Error('Legacy thumbnail master could not be normalized');
    }
    masterPath = normalizedMaster;
  }
  const libraryPath = String(asset.library_storage_path || join(directory, `thumbnail-v${version}-library.webp`));
  const websitePath = String(asset.website_storage_path || join(directory, `thumbnail-v${version}-website.webp`));
  if (!existsSync(libraryPath)) createWebpDerivative(masterPath, libraryPath, 640, 76);
  if (!existsSync(websitePath)) createWebpDerivative(masterPath, websitePath, Number(asset.width), 84);
  const masterBytes = readFileSync(masterPath);
  db.query(`UPDATE thumbnail_assets SET storage_path=?1,mime_type='image/png',size_bytes=?2,sha256=?3,
    library_storage_path=?4,library_size_bytes=?5,website_storage_path=?6,website_size_bytes=?7 WHERE id=?8`)
    .run(masterPath, masterBytes.byteLength, bytesToHex(sha256(masterBytes)), libraryPath, statSync(libraryPath).size, websitePath, statSync(websitePath).size, assetId);
  asset = getThumbnailAssetRow(assetId);
  return asset;
}

export function finishEpisodeThumbnail(row: Record<string, unknown>, destination: string) {
  const episode = getEpisode(String(row.episode_id));
  if (!episode) throw new Error('Episode not found');
  const displayTitle = String(episode.publicTitle || episode.workingTitle)
    .replace(/^episode\s+\d+\s*:\s*/i, '').replace(/\s+v\d+$/i, '').trim();
  const words = displayTitle.toUpperCase().split(/\s+/).filter(Boolean);
  let split = 1;
  let splitScore = Number.POSITIVE_INFINITY;
  for (let index = 1; index < words.length; index += 1) {
    const score = Math.abs(words.slice(0, index).join(' ').length - words.slice(index).join(' ').length);
    if (score < splitScore) { split = index; splitScore = score; }
  }
  const punctuationBreak = words.findIndex((word, index) => index > 0 && index < words.length - 1 && /[,;:]$/.test(word));
  if (punctuationBreak > 0) split = punctuationBreak + 1;
  const lead = words.slice(0, split).join(' ');
  const accent = words.slice(split).join(' ') || words.slice(0, split).join(' ');
  const contributorIds = parseStringArray(row.contributor_ids_json);
  const guests = contributorIds.map(getContributor).filter((item) => item && !['pete-winn','andy-david'].includes(item.id));
  const guestLine = guests.length ? `Feat. ${guests.map((item) => item!.name).join(' & ')}` : '';
  const displayFont = resolve('public/fonts/Anton-Regular.ttf');
  const pixelFont = resolve('public/fonts/Jersey15-Regular.ttf');
  const temporary = mkdtempSync('/tmp/snack-studio-episode-');
  const centralWhitespace = (y: number, height: number, fallbackWidth: number) => {
    const projection = Bun.spawnSync([
      'magick', String(row.source_uri), '-resize', '1672x941^', '-gravity', 'center', '-extent', '1672x941',
      '-crop', `1672x${height}+0+${y}`, '+repage', '-colorspace', 'gray', '-threshold', '88%', '-negate',
      '-scale', '1672x1!', 'txt:-',
    ]);
    if (projection.exitCode !== 0) return { x: Math.round((1672 - fallbackWidth) / 2), width: fallbackWidth };
    const occupancy = new Array<number>(1672).fill(100);
    for (const line of projection.stdout.toString().split('\n')) {
      const match = line.match(/^(\d+),0:.*gray\(([\d.]+)(%)?\)/);
      if (match) occupancy[Number(match[1])] = match[3] ? Number(match[2]) : Number(match[2]) * 100 / 255;
    }
    const centre = 836;
    let left = centre; let right = centre;
    while (left > 0 && occupancy[left - 1]! <= 20) left -= 1;
    while (right < 1671 && occupancy[right + 1]! <= 20) right += 1;
    const inset = 22;
    const measuredWidth = right - left + 1 - inset * 2;
    if (measuredWidth < 360) return { x: Math.round((1672 - fallbackWidth) / 2), width: fallbackWidth };
    return { x: left + inset, width: measuredWidth };
  };
  const renderLabel = (name: string, text: string, font: string, pointSize: number, colour: string, maxWidth?: number, preserveHeight = false) => {
    const path = join(temporary, `${name}.png`);
    const identifyLabel = () => {
      const result = Bun.spawnSync(['identify', '-format', '%w %h', path]);
      if (result.exitCode !== 0) throw new Error(`Could not measure episode thumbnail ${name}`);
      const [width, height] = result.stdout.toString().trim().split(/\s+/).map(Number);
      return { width, height };
    };
    let size = pointSize;
    let dimensions = { width: 0, height: 0 };
    do {
      const rendered = Bun.spawnSync(['magick', '-background', 'none', '-font', font, '-fill', colour, '-pointsize', String(size), `label:${text}`, '-trim', '+repage', path]);
      if (rendered.exitCode !== 0) throw new Error(`Could not render episode thumbnail ${name}`);
      dimensions = identifyLabel();
      if (preserveHeight && maxWidth && dimensions.width > maxWidth) {
        const fitted = Bun.spawnSync(['magick', path, '-resize', `${maxWidth}x${dimensions.height}!`, path]);
        if (fitted.exitCode !== 0) throw new Error(`Could not fit episode thumbnail ${name}`);
        dimensions = identifyLabel();
        break;
      }
      size -= 6;
    } while (maxWidth && dimensions.width > maxWidth && size >= 54);
    return { path, ...dimensions };
  };
  const forceDimensions = (layer: { path: string; width: number; height: number }, width: number, height: number) => {
    const fitted = Bun.spawnSync(['magick', layer.path, '-resize', `${width}x${height}!`, layer.path]);
    if (fitted.exitCode !== 0) throw new Error('Could not apply canonical episode typography dimensions');
    return { ...layer, width, height };
  };
  try {
    const hasGuest = guests.length > 0;
    const leadSpace = hasGuest ? { x: 52, width: 810 } : centralWhitespace(145, 270, 660);
    const accentSpace = hasGuest ? { x: 54, width: 620 } : centralWhitespace(325, 335, 660);
    const leadLayer = hasGuest
      ? renderLabel('lead', lead, displayFont, 255, '#0f0f0f', leadSpace.width)
      : forceDimensions(renderLabel('lead', lead, displayFont, 155, '#0f0f0f'), 655, 112);
    const accentLayer = hasGuest
      ? renderLabel('accent', accent, displayFont, 235, '#efeded', 620)
      : forceDimensions(renderLabel('accent', accent, displayFont, 315, '#efeded'), 616, 282);
    const guestLayer = guestLine ? renderLabel('guest', guestLine, displayFont, 105, '#171717', 740) : null;
    const brandLayer = hasGuest
      ? renderLabel('brand', 'INTELLIGENCE SNACKS', pixelFont, 68, '#efeded', 540)
      : forceDimensions(renderLabel('brand', 'INTELLIGENCE SNACKS', pixelFont, 58, '#efeded'), 385, 40);
    const episodeLayer = hasGuest
      ? renderLabel('episode', `- ${episode.episodeNumber || ''}`, pixelFont, 68, '#f94901', 160)
      : forceDimensions(renderLabel('episode', `- ${episode.episodeNumber || ''}`, pixelFont, 58, '#f94901'), 62, 40);
    const accentPadX = hasGuest ? 34 : 40; const accentPadY = hasGuest ? 30 : 26;
    const accentWidth = accentLayer.width + accentPadX * 2;
    const accentX = hasGuest ? 54 : 488;
    const leadX = hasGuest ? 52 : 505;
    const leadY = hasGuest ? 205 : 200;
    const accentY = episodeTitleAccentY(hasGuest ? 'two-hosts-plus-guest' : 'two-hosts', leadY, leadLayer.height);
    const brandPadX = hasGuest ? 18 : 26; const brandPadY = hasGuest ? 10 : 15;
    const brandGap = 10; const brandWidth = brandLayer.width + episodeLayer.width + brandGap;
    const brandX = hasGuest ? 45 : 575;
    const brandY = hasGuest ? 64 : 765;
    const args = ['magick', String(row.source_uri), '-resize', '1672x941^', '-gravity', 'center', '-extent', '1672x941',
      '-gravity', 'northwest',
      '(', '-size', '1672x941', 'xc:none', '-fill', 'rgba(36,36,36,.22)', '-draw', `roundrectangle ${accentX + 3},${accentY + 7} ${accentX + accentLayer.width + accentPadX * 2 + 3},${accentY + accentLayer.height + accentPadY * 2 + 7} 3,3`, '-blur', '0x15', ')', '-composite',
      '-fill', '#f94901', '-draw', `roundrectangle ${accentX},${accentY} ${accentX + accentLayer.width + accentPadX * 2},${accentY + accentLayer.height + accentPadY * 2} 3,3`,
      '(', leadLayer.path, '-channel', 'A', '-evaluate', 'multiply', '0.32', '+channel', '-blur', '0x7', ')', '-gravity', 'northwest', '-geometry', `+${leadX + 4}+${leadY + 7}`, '-composite', '-channel', 'RGBA',
      '(', leadLayer.path, ')', '-gravity', 'northwest', '-geometry', `+${leadX}+${leadY}`, '-composite',
      '(', accentLayer.path, '-channel', 'A', '-evaluate', 'multiply', '0.26', '+channel', '-blur', '0x7', ')', '-gravity', 'northwest', '-geometry', `+${accentX + accentPadX + 4}+${accentY + accentPadY + 7}`, '-composite', '-channel', 'RGBA',
      '(', accentLayer.path, ')', '-gravity', 'northwest', '-geometry', `+${accentX + accentPadX}+${accentY + accentPadY}`, '-composite'];
    if (guestLayer) args.push('(', guestLayer.path, ')', '-gravity', 'northwest', '-geometry', '+54+770', '-composite');
    if (!hasGuest) args.push('-fill', 'none', '-stroke', '#f94901', '-strokewidth', '5', '-draw', "path 'M 874,681 C 835,684 811,711 800,756 M 800,756 L 797,736 M 800,756 L 817,743'", '-stroke', 'none');
    args.push('-fill', '#0a0a0a', '-draw', `roundrectangle ${brandX},${brandY} ${brandX + brandWidth + brandPadX * 2},${brandY + Math.max(brandLayer.height, episodeLayer.height) + brandPadY * 2} 12,12`,
      '(', brandLayer.path, ')', '-gravity', 'northwest', '-geometry', `+${brandX + brandPadX}+${brandY + brandPadY}`, '-composite',
      '(', episodeLayer.path, ')', '-gravity', 'northwest', '-geometry', `+${brandX + brandPadX + brandLayer.width + brandGap}+${brandY + brandPadY}`, '-composite');
    // The canonical host silhouettes are the final visual layer. This permits the
    // highlight block to tuck slightly behind a character without ever painting
    // title graphics over Pete or Andy.
    if (!hasGuest && existsSync(EPISODE_THUMBNAIL_TWO_HOST_FOREGROUND)) {
      args.push('(', EPISODE_THUMBNAIL_TWO_HOST_FOREGROUND, ')', '-gravity', 'northwest', '-geometry', '+0+0', '-composite');
    }
    args.push('-strip', destination);
    return Bun.spawnSync(args);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function preserveUploadedEpisodeThumbnail(source: string, destination: string) {
  return Bun.spawnSync([
    'magick', source,
    '-auto-orient',
    '-strip',
    '-define', 'webp:method=6',
    '-quality', '96',
    destination,
  ]);
}

export async function uploadEpisodeThumbnail(jobId: string, file: File, actorPubkey: string) {
  const job = getThumbnailJob(jobId);
  if (!job || job.assetKind !== 'episode') throw new Error('Episode thumbnail job not found');
  if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 15 * 1024 * 1024) throw new Error('Upload a PNG, JPEG or WebP up to 15 MB');
  const round = Number(job.generationRound || 0) + 1;
  const directory = resolve(join(CONTRIBUTOR_UPLOAD_DIR, '..', 'thumbnails', job.id, `round-${round}`)); mkdirSync(directory, { recursive: true });
  const source = join(directory, 'candidate-1-upload'); writeFileSync(source, new Uint8Array(await file.arrayBuffer()));
  thumbnailDimensions(source, 'episode'); const preview = join(directory, 'candidate-1-finished.webp');
  const finished = preserveUploadedEpisodeThumbnail(source, preview); if (finished.exitCode !== 0) throw new Error('Episode thumbnail upload could not be prepared');
  const dimensions = thumbnailDimensions(preview, 'episode'); const now = Date.now(); const id = crypto.randomUUID();
  db.transaction(() => { db.query(`INSERT INTO thumbnail_candidates(id,job_id,generation_round,candidate_number,source_uri,prompt_text,model_name,width,height,mime_type,size_bytes,created_at) VALUES(?1,?2,?3,1,?4,'Editorial upload','upload',?5,?6,'image/webp',?7,?8)`).run(id, job.id, round, preview, dimensions.width, dimensions.height, statSync(preview).size, now); db.query("UPDATE thumbnail_jobs SET status='in-review',generation_round=?1,updated_at=?2 WHERE id=?3").run(round, now, job.id); recordAuditEvent({ actorPubkey, action:'thumbnail.episode.uploaded', entityType:'thumbnail-job', entityId:job.id }); })();
  return getThumbnailJobDetail(job.id)!;
}

export function listThumbnailJobs(episodeId: string): ThumbnailJob[] {
  // Pipeline-level failures can occur before the definition reaches its webhook.
  // Never leave those jobs presenting as active forever.
  const staleBefore = Date.now() - 30 * 60 * 1000;
  db.query(`UPDATE thumbnail_jobs
    SET status='failed', failure_summary='Thumbnail generation stopped without returning a result. Retry the thumbnail.', updated_at=?1
    WHERE episode_id=?2 AND status IN ('extracting','grounding','generating') AND updated_at < ?3`)
    .run(Date.now(), episodeId, staleBefore);
  return (db.query("SELECT * FROM thumbnail_jobs WHERE episode_id = ?1 ORDER BY created_at DESC")
    .all(episodeId) as Record<string, unknown>[]).map(mapThumbnailJob);
}

export function getThumbnailJob(id: string): ThumbnailJob | null {
  const row = db.query("SELECT * FROM thumbnail_jobs WHERE id = ?1").get(id) as Record<string, unknown> | null;
  return row ? mapThumbnailJob(row) : null;
}

export function createThumbnailJob(input: ThumbnailBriefInput & { episodeId: string; actorPubkey: string }): ThumbnailJob {
  const episode = getEpisode(input.episodeId);
  if (!episode) throw new Error("Episode not found");
  if (!episode.activeTranscriptRevisionId) throw new Error("An active transcript is required");
  if (episode.status !== "approved") throw new Error("Approve the final Snack set before creating thumbnails");

  let snackRevisionId: string | null = null;
  if (input.assetKind === "snack") {
    const candidate = getCandidate(input.snackCandidateId!);
    if (!candidate || candidate.episodeId !== input.episodeId) throw new Error("Snack does not belong to this episode");
    const approved = validateApprovedCandidateBatch(input.episodeId);
    if (!approved.ready || !approved.candidateIds.includes(candidate.id)) throw new Error("Snack is not part of the approved final set");
    snackRevisionId = candidate.currentRevisionId;
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.query(`INSERT INTO thumbnail_jobs(
      id, episode_id, asset_kind, snack_candidate_id, snack_revision_id, transcript_revision_id,
      status, topic_colour, contributor_ids_json, review_notes, created_by_pubkey, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'draft', ?7, ?8, ?9, ?10, ?11, ?11)`)
      .run(id, input.episodeId, input.assetKind, input.snackCandidateId, snackRevisionId,
        episode.activeTranscriptRevisionId, input.topicColour, JSON.stringify(input.contributorIds),
        input.reviewNotes, input.actorPubkey, now);
    recordAuditEvent({
      actorPubkey: input.actorPubkey,
      action: "thumbnail.brief.created",
      entityType: "episode",
      entityId: input.episodeId,
      detail: { thumbnailJobId: id, assetKind: input.assetKind, snackCandidateId: input.snackCandidateId },
    });
  })();
  return getThumbnailJob(id)!;
}

function publicationContext(episodeId: string) {
  const episode = getEpisode(episodeId);
  if (!episode) throw new Error("Episode not found");
  if (episode.status !== "approved") throw new Error("Approve the final Snack set before preparing publication");
  const transcript = getActiveTranscriptRevision(episodeId);
  if (!transcript) throw new Error("An active transcript is required");
  const approved = validateApprovedCandidateBatch(episodeId);
  if (!approved.ready) throw new Error("The approved Snack set is not ready");

  const participants = resolveTranscriptParticipants(transcript.transcriptText);
  const contributorIds = participants.resolved.map(({ contributorId }) => contributorId);
  if (!contributorIds.length) throw new Error("No episode contributors could be resolved from the transcript");
  return { approved, transcript, participants, contributorIds };
}

export function getPublicationPreparation(episodeId: string) {
  const { participants } = publicationContext(episodeId);
  const jobs = listThumbnailJobs(episodeId);
  const contributors = participants.resolved.map((participant) => ({
    ...participant,
    profile: getContributor(participant.contributorId),
  }));
  const contributorsNeedingPortraits = contributors
    .filter(({ profile }) => profile?.portraitStatus !== 'approved' || !profile.portraitPath)
    .map(({ contributorId, name, profile }) => ({ contributorId, name, portraitStatus: profile?.portraitStatus || 'needed' }));
  const episodeThemeCount = Number((db.query('SELECT COUNT(*) AS count FROM episode_theme_assignments WHERE episode_id=?1').get(episodeId) as { count: number }).count);
  const themes = (db.query('SELECT t.id,t.name,t.description,t.colour FROM episode_theme_assignments a JOIN themes t ON t.id=a.theme_id WHERE a.episode_id=?1 ORDER BY a.created_at,t.name').all(episodeId) as Array<{ id: string; name: string; description: string; colour: string }>);
  const needsThemeClassification = jobs.filter((job) => job.assetKind === 'snack' && !db.query('SELECT 1 FROM snack_theme_assignments WHERE snack_revision_id=?1 LIMIT 1').get(job.snackRevisionId)).map((job) => job.snackCandidateId);
  return {
    jobs,
    participants: { ...participants, resolved: contributors },
    contributorsNeedingPortraits,
    themes,
    needsTopicClassification: episodeThemeCount ? needsThemeClassification : jobs.filter((job) => job.assetKind === 'snack').map((job) => job.snackCandidateId),
    ready: jobs.length > 0 && participants.unresolved.length === 0 && contributorsNeedingPortraits.length === 0
      && episodeThemeCount > 0 && needsThemeClassification.length === 0 && jobs.every((job) => job.assetKind !== "snack" || Boolean(job.topicColour)),
  };
}

export function preparePublicationThumbnails(episodeId: string, actorPubkey: string) {
  const { approved, transcript, participants, contributorIds } = publicationContext(episodeId);
  const now = Date.now();
  db.transaction(() => {
    for (const candidateId of approved.candidateIds) {
      const candidate = getCandidate(candidateId)!;
      const assignment = db.query('SELECT theme_id FROM snack_theme_assignments WHERE snack_revision_id=?1').get(candidate.currentRevisionId) as { theme_id: string } | null;
      const theme = assignment ? getTheme(assignment.theme_id) : null;
      db.query(`INSERT OR IGNORE INTO thumbnail_jobs(
        id, episode_id, asset_kind, snack_candidate_id, snack_revision_id, transcript_revision_id,
        status, topic_colour, contributor_ids_json, created_by_pubkey, created_at, updated_at
      ) VALUES (?1, ?2, 'snack', ?3, ?4, ?5, 'draft', ?6, ?7, ?8, ?9, ?9)`)
        .run(crypto.randomUUID(), episodeId, candidate.id, candidate.currentRevisionId,
          transcript.id, theme?.colour || null, JSON.stringify(contributorIds), actorPubkey, now);
    }
    db.query(`INSERT OR IGNORE INTO thumbnail_jobs(id,episode_id,asset_kind,transcript_revision_id,status,contributor_ids_json,created_by_pubkey,created_at,updated_at) VALUES(?1,?2,'episode',?3,'draft',?4,?5,?6,?6)`)
      .run(crypto.randomUUID(), episodeId, transcript.id, JSON.stringify(contributorIds), actorPubkey, now);
    db.query("UPDATE thumbnail_jobs SET contributor_ids_json = ?1, updated_at = ?2 WHERE episode_id = ?3")
      .run(JSON.stringify(contributorIds), now, episodeId);
    recordAuditEvent({
      actorPubkey,
      action: "publication.thumbnails.prepared",
      entityType: "episode",
      entityId: episodeId,
      detail: { candidateIds: approved.candidateIds, contributorIds, unresolvedContributors: participants.unresolved },
    });
  })();

  return getPublicationPreparation(episodeId);
}
