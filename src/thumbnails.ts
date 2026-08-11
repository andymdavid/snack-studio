import { db } from "./db.ts";
import { getCandidate, validateApprovedCandidateBatch } from "./candidates.ts";
import { getActiveTranscriptRevision, getEpisode, recordAuditEvent } from "./episodes.ts";
import type { ThumbnailAssetKind, ThumbnailBriefInput } from "./thumbnail-input.ts";
import { resolveCanonicalTopic, resolveTranscriptParticipants } from "./publication-metadata.ts";
import { getContributor } from "./contributors.ts";
import { bytesToHex } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join, normalize, extname } from 'node:path';
import { CONTRIBUTOR_UPLOAD_DIR } from './config.ts';
import { getCurrentAutopilotTarget } from './db.ts';

export type ThumbnailJobStatus = "draft" | "extracting" | "grounding" | "generating" | "in-review" | "approved" | "failed";

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

export function getThumbnailJobDetail(id: string) {
  const job = getThumbnailJob(id);
  if (!job) return null;
  const evidence = db.query('SELECT * FROM thumbnail_object_evidence WHERE job_id = ?1 ORDER BY created_at').all(id);
  const candidates = (db.query('SELECT * FROM thumbnail_candidates WHERE job_id = ?1 ORDER BY generation_round DESC, candidate_number').all(id) as Record<string, unknown>[])
    .map((row) => ({ ...row, previewUrl: `/api/thumbnail-candidates/${encodeURIComponent(String(row.id))}/image` }));
  return { ...job, evidence, candidates };
}

export function getThumbnailCandidateRow(id: string) {
  return db.query('SELECT * FROM thumbnail_candidates WHERE id = ?1').get(id) as Record<string, unknown> | null;
}

export function createThumbnailGeneration(jobId: string, actorPubkey: string, publicOrigin: string) {
  const job = getThumbnailJob(jobId);
  if (!job || job.assetKind !== 'snack' || !job.snackCandidateId) throw new Error('Snack thumbnail job not found');
  if (!job.topicColour) throw new Error('Topic colour is required');
  const candidate = getCandidate(job.snackCandidateId);
  const transcript = getActiveTranscriptRevision(job.episodeId);
  if (!candidate || !transcript) throw new Error('Thumbnail source context is incomplete');
  const contributors = job.contributorIds.map(getContributor);
  if (contributors.some((item) => !item?.portraitPath || item.portraitStatus !== 'approved')) throw new Error('Every contributor needs an approved portrait');
  const round = Number(job.generationRound || 0) + 1;
  const outputDirectory = resolve(join(CONTRIBUTOR_UPLOAD_DIR, '..', 'thumbnails', job.id, `round-${round}`));
  mkdirSync(outputDirectory, { recursive: true });
  const contextPath = join(outputDirectory, 'context.json');
  writeFileSync(contextPath, JSON.stringify({
    jobId: job.id, snack: candidate.revision, transcript: transcript.transcriptText, topicColour: job.topicColour,
    contributors: contributors.map((item) => ({ id: item!.id, name: item!.name, portraitPath: resolve(`public${item!.portraitPath}`) })),
  }, null, 2));
  const token = `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
  db.query("UPDATE thumbnail_jobs SET status='extracting', callback_token_hash=?1, generation_round=?2, pipeline_name='snack-studio-snack-thumbnail', pipeline_version='1', failure_summary=NULL, updated_at=?3 WHERE id=?4")
    .run(hashToken(token), round, Date.now(), job.id);
  recordAuditEvent({ actorPubkey, action: 'thumbnail.generation.started', entityType: 'thumbnail-job', entityId: job.id, detail: { round } });
  const target = getCurrentAutopilotTarget();
  return {
    job: getThumbnailJob(job.id),
    triggerRequest: {
      url: new URL('/api/pipelines/triggers/http/snack-studio-snack-thumbnail.v1', target.url).toString(), method: 'POST',
      body: { input: { source: 'snack-studio', operation: 'snack-thumbnail', jobId: job.id, generationRound: round, contextPath, outputDirectory, agent: 'codex', webhook: { url: `${publicOrigin.replace(/\/$/, '')}/api/thumbnail-webhooks/${job.id}`, token, authHeader: 'x-snack-studio-token' } } },
    },
  };
}

export function markThumbnailGenerationStarted(jobId: string, runId: string) {
  db.query("UPDATE thumbnail_jobs SET status='generating', autopilot_run_id=?1, updated_at=?2 WHERE id=?3").run(runId, Date.now(), jobId);
}

function safeThumbnailPath(jobId: string, round: number, value: string) {
  const base = resolve(join(CONTRIBUTOR_UPLOAD_DIR, '..', 'thumbnails', jobId, `round-${round}`));
  const path = resolve(normalize(value));
  if (!path.startsWith(`${base}/`) || !existsSync(path)) throw new Error('Thumbnail candidate is outside its generation directory');
  return path;
}

export function applyThumbnailResult(jobId: string, token: string, body: Record<string, unknown>) {
  const row = db.query('SELECT * FROM thumbnail_jobs WHERE id=?1').get(jobId) as Record<string, unknown> | null;
  if (!row || String(row.callback_token_hash || '') !== hashToken(token)) throw new Error('Invalid thumbnail callback');
  const response = body.response && typeof body.response === 'object' ? body.response as Record<string, unknown> : body;
  const evidence = Array.isArray(response.evidence) ? response.evidence : [];
  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  if (candidates.length !== 3) throw new Error('Thumbnail result requires three candidates');
  const round = Number(row.generation_round); const now = Date.now();
  db.transaction(() => {
    db.query('DELETE FROM thumbnail_object_evidence WHERE job_id=?1').run(jobId);
    for (const raw of evidence) {
      const item = raw as Record<string, unknown>;
      db.query(`INSERT INTO thumbnail_object_evidence(id,job_id,object_name,transcript_excerpt,timestamp_label,role_in_snack,grounding_status,grounding_rationale,created_at) VALUES(?1,?2,?3,?4,?5,?6,'approved',?7,?8)`)
        .run(crypto.randomUUID(), jobId, String(item.object || ''), String(item.evidence || ''), String(item.timestamp || ''), String(item.roleInSnack || ''), String(item.rationale || ''), now);
    }
    for (const [index, raw] of candidates.entries()) {
      const item = raw as Record<string, unknown>; const path = safeThumbnailPath(jobId, round, String(item.path || ''));
      db.query(`INSERT INTO thumbnail_candidates(id,job_id,generation_round,candidate_number,source_uri,prompt_text,model_name,width,height,mime_type,size_bytes,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,1536,1024,?8,?9,?10)`)
        .run(crypto.randomUUID(), jobId, round, index + 1, path, String(response.prompt || ''), String(response.model || ''), String(item.mimeType || (extname(path)==='.webp'?'image/webp':'image/png')), statSync(path).size, now);
    }
    db.query("UPDATE thumbnail_jobs SET status='in-review', updated_at=?1 WHERE id=?2").run(now, jobId);
  })();
}

export function listThumbnailJobs(episodeId: string): ThumbnailJob[] {
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
  return {
    jobs,
    participants: { ...participants, resolved: contributors },
    contributorsNeedingPortraits,
    needsTopicClassification: jobs.filter((job) => job.assetKind === "snack" && !job.topicColour).map((job) => job.snackCandidateId),
    ready: jobs.length > 0 && participants.unresolved.length === 0 && contributorsNeedingPortraits.length === 0
      && jobs.every((job) => job.assetKind !== "snack" || Boolean(job.topicColour)),
  };
}

export function preparePublicationThumbnails(episodeId: string, actorPubkey: string) {
  const { approved, transcript, participants, contributorIds } = publicationContext(episodeId);
  const now = Date.now();
  db.transaction(() => {
    for (const candidateId of approved.candidateIds) {
      const candidate = getCandidate(candidateId)!;
      const storedMetadata = db.query("SELECT primary_topic FROM publication_snack_metadata WHERE snack_revision_id = ?1")
        .get(candidate.currentRevisionId) as { primary_topic: string } | null;
      const topic = resolveCanonicalTopic(storedMetadata?.primary_topic || candidate.revision.primaryTopic);
      db.query(`INSERT OR IGNORE INTO thumbnail_jobs(
        id, episode_id, asset_kind, snack_candidate_id, snack_revision_id, transcript_revision_id,
        status, topic_colour, contributor_ids_json, created_by_pubkey, created_at, updated_at
      ) VALUES (?1, ?2, 'snack', ?3, ?4, ?5, 'draft', ?6, ?7, ?8, ?9, ?9)`)
        .run(crypto.randomUUID(), episodeId, candidate.id, candidate.currentRevisionId,
          transcript.id, topic?.colour || null, JSON.stringify(contributorIds), actorPubkey, now);
    }
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
