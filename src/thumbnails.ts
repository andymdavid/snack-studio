import { db } from "./db.ts";
import { getCandidate, validateApprovedCandidateBatch } from "./candidates.ts";
import { getActiveTranscriptRevision, getEpisode, recordAuditEvent } from "./episodes.ts";
import type { ThumbnailAssetKind, ThumbnailBriefInput } from "./thumbnail-input.ts";
import { resolveCanonicalTopic, resolveTranscriptParticipants } from "./publication-metadata.ts";

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
  };
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
  return {
    jobs,
    participants,
    needsTopicClassification: jobs.filter((job) => job.assetKind === "snack" && !job.topicColour).map((job) => job.snackCandidateId),
    ready: jobs.length > 0 && participants.unresolved.length === 0 && jobs.every((job) => job.assetKind !== "snack" || Boolean(job.topicColour)),
  };
}

export function preparePublicationThumbnails(episodeId: string, actorPubkey: string) {
  const { approved, transcript, participants, contributorIds } = publicationContext(episodeId);
  const now = Date.now();
  db.transaction(() => {
    for (const candidateId of approved.candidateIds) {
      const candidate = getCandidate(candidateId)!;
      const topic = resolveCanonicalTopic(candidate.revision.primaryTopic);
      db.query(`INSERT OR IGNORE INTO thumbnail_jobs(
        id, episode_id, asset_kind, snack_candidate_id, snack_revision_id, transcript_revision_id,
        status, topic_colour, contributor_ids_json, created_by_pubkey, created_at, updated_at
      ) VALUES (?1, ?2, 'snack', ?3, ?4, ?5, 'draft', ?6, ?7, ?8, ?9, ?9)`)
        .run(crypto.randomUUID(), episodeId, candidate.id, candidate.currentRevisionId,
          transcript.id, topic?.colour || null, JSON.stringify(contributorIds), actorPubkey, now);
    }
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
