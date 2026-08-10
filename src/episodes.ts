import { db } from "./db.ts";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TRANSCRIPT_UPLOAD_DIR } from "./config.ts";

export const EPISODE_STATUSES = [
  "transcript-preparation",
  "ready-for-extraction",
  "processing",
  "in-review",
  "approved",
  "published",
  "failed",
] as const;

export type EpisodeStatus = typeof EPISODE_STATUSES[number];

export type Episode = {
  id: string;
  episodeNumber: number | null;
  workingTitle: string;
  publicTitle: string | null;
  recordedOn: string | null;
  audioUrl: string | null;
  videoUrl: string | null;
  editorialNotes: string | null;
  activeTranscriptRevisionId: string | null;
  status: EpisodeStatus;
  ownerPubkey: string;
  createdAt: number;
  updatedAt: number;
};

export type TranscriptRevision = {
  id: string;
  episodeId: string;
  sourceId: string;
  sourceKind: "pasted" | "upload";
  revisionNumber: number;
  transcriptText: string;
  sha256: string;
  sizeBytes: number;
  changeNote: string | null;
  originalFilename: string | null;
  createdByPubkey: string;
  createdAt: number;
};

export type AuditEvent = {
  id: string;
  actorPubkey: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  detail: Record<string, unknown> | null;
  createdAt: number;
};

function mapEpisode(row: Record<string, unknown>): Episode {
  return {
    id: String(row.id),
    episodeNumber: row.episode_number == null ? null : Number(row.episode_number),
    workingTitle: String(row.working_title),
    publicTitle: row.public_title == null ? null : String(row.public_title),
    recordedOn: row.recorded_on == null ? null : String(row.recorded_on),
    audioUrl: row.audio_url == null ? null : String(row.audio_url),
    videoUrl: row.video_url == null ? null : String(row.video_url),
    editorialNotes: row.editorial_notes == null ? null : String(row.editorial_notes),
    activeTranscriptRevisionId: row.active_transcript_revision_id == null ? null : String(row.active_transcript_revision_id),
    status: String(row.status) as EpisodeStatus,
    ownerPubkey: String(row.owner_pubkey),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapTranscriptRevision(row: Record<string, unknown>): TranscriptRevision {
  return {
    id: String(row.id),
    episodeId: String(row.episode_id),
    sourceId: String(row.source_id),
    sourceKind: String(row.source_kind) as TranscriptRevision["sourceKind"],
    revisionNumber: Number(row.revision_number),
    transcriptText: String(row.transcript_text),
    sha256: String(row.sha256),
    sizeBytes: Number(row.revision_size_bytes ?? row.size_bytes),
    changeNote: row.change_note == null ? null : String(row.change_note),
    originalFilename: row.original_filename == null ? null : String(row.original_filename),
    createdByPubkey: String(row.created_by_pubkey),
    createdAt: Number(row.created_at),
  };
}

function parseDetail(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function mapAuditEvent(row: Record<string, unknown>): AuditEvent {
  return {
    id: String(row.id),
    actorPubkey: row.actor_pubkey == null ? null : String(row.actor_pubkey),
    action: String(row.action),
    entityType: String(row.entity_type),
    entityId: row.entity_id == null ? null : String(row.entity_id),
    detail: parseDetail(row.detail_json),
    createdAt: Number(row.created_at),
  };
}

export function listEpisodes(): Episode[] {
  const rows = db.query("SELECT * FROM episodes ORDER BY updated_at DESC, created_at DESC").all() as Record<string, unknown>[];
  return rows.map(mapEpisode);
}

export function getEpisode(id: string): Episode | null {
  const row = db.query("SELECT * FROM episodes WHERE id = ?1").get(id) as Record<string, unknown> | null;
  return row ? mapEpisode(row) : null;
}

export function findEpisodeByNumber(episodeNumber: number): Episode | null {
  const row = db.query("SELECT * FROM episodes WHERE episode_number = ?1").get(episodeNumber) as Record<string, unknown> | null;
  return row ? mapEpisode(row) : null;
}

const ACTIVE_PIPELINE_STATUSES = [
  "created", "awaiting-authorization", "queued", "running", "applying-result",
] as const;

export function deleteEpisodeWorkspace(id: string): "deleted" | "not-found" | "pipeline-active" {
  if (!getEpisode(id)) return "not-found";
  const placeholders = ACTIVE_PIPELINE_STATUSES.map(() => "?").join(", ");
  const activeRequest = db.query(
    `SELECT 1 FROM pipeline_requests WHERE episode_id = ? AND status IN (${placeholders}) LIMIT 1`,
  ).get(id, ...ACTIVE_PIPELINE_STATUSES);
  if (activeRequest) return "pipeline-active";

  db.transaction(() => {
    db.query("DELETE FROM episodes WHERE id = ?1").run(id);
    db.query("DELETE FROM audit_events WHERE entity_type = 'episode' AND entity_id = ?1").run(id);
  })();
  try {
    rmSync(join(TRANSCRIPT_UPLOAD_DIR, id), { recursive: true, force: true });
  } catch (error) {
    console.warn(`Episode ${id} was deleted, but its transcript upload directory could not be removed`, error);
  }
  return "deleted";
}

export function recordAuditEvent(input: {
  actorPubkey?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  detail?: Record<string, unknown> | null;
}): AuditEvent {
  const event: AuditEvent = {
    id: crypto.randomUUID(),
    actorPubkey: input.actorPubkey ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    detail: input.detail ?? null,
    createdAt: Date.now(),
  };
  db.query(`
    INSERT INTO audit_events(id, actor_pubkey, action, entity_type, entity_id, detail_json, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
  `).run(
    event.id,
    event.actorPubkey,
    event.action,
    event.entityType,
    event.entityId,
    event.detail ? JSON.stringify(event.detail) : null,
    event.createdAt,
  );
  return event;
}

export function createEpisode(input: {
  episodeNumber: number | null;
  workingTitle: string;
  ownerPubkey: string;
}): Episode {
  const now = Date.now();
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.query(`
      INSERT INTO episodes(id, episode_number, working_title, status, owner_pubkey, created_at, updated_at)
      VALUES (?1, ?2, ?3, 'transcript-preparation', ?4, ?5, ?5)
    `).run(id, input.episodeNumber, input.workingTitle, input.ownerPubkey, now);
    recordAuditEvent({
      actorPubkey: input.ownerPubkey,
      action: "episode.created",
      entityType: "episode",
      entityId: id,
      detail: { episodeNumber: input.episodeNumber, workingTitle: input.workingTitle },
    });
  })();
  return getEpisode(id)!;
}

export function updateEpisodeMetadata(id: string, input: {
  episodeNumber: number | null;
  workingTitle: string;
  publicTitle: string | null;
  recordedOn: string | null;
  audioUrl: string | null;
  videoUrl: string | null;
  editorialNotes: string | null;
  actorPubkey: string;
}): Episode | null {
  if (!getEpisode(id)) return null;
  const now = Date.now();
  db.transaction(() => {
    db.query(`
      UPDATE episodes
      SET episode_number = ?1, working_title = ?2, public_title = ?3, recorded_on = ?4, audio_url = ?5,
          video_url = ?6, editorial_notes = ?7, updated_at = ?8
      WHERE id = ?9
    `).run(input.episodeNumber, input.workingTitle, input.publicTitle, input.recordedOn, input.audioUrl, input.videoUrl, input.editorialNotes, now, id);
    recordAuditEvent({
      actorPubkey: input.actorPubkey,
      action: "episode.metadata.updated",
      entityType: "episode",
      entityId: id,
      detail: { episodeNumber: input.episodeNumber, workingTitle: input.workingTitle, publicTitle: input.publicTitle, recordedOn: input.recordedOn },
    });
  })();
  return getEpisode(id);
}

function hashText(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}

export function createPastedTranscriptRevision(input: {
  episodeId: string;
  transcriptText: string;
  sizeBytes: number;
  changeNote: string | null;
  actorPubkey: string;
}): TranscriptRevision {
  const now = Date.now();
  const active = getActiveTranscriptRevision(input.episodeId);
  const sourceId = active?.sourceId || crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const digest = hashText(input.transcriptText);
  const nextRow = db.query("SELECT COALESCE(MAX(revision_number), 0) + 1 AS next FROM transcript_revisions WHERE episode_id = ?1")
    .get(input.episodeId) as { next: number };
  const revisionNumber = Number(nextRow.next);

  db.transaction(() => {
    if (!active) {
      db.query(`
        INSERT INTO transcript_sources(
          id, episode_id, source_kind, media_type, size_bytes, sha256, source_text,
          created_by_pubkey, created_at
        ) VALUES (?1, ?2, 'pasted', 'text/plain', ?3, ?4, ?5, ?6, ?7)
      `).run(sourceId, input.episodeId, input.sizeBytes, digest, input.transcriptText, input.actorPubkey, now);
    }
    db.query(`
      INSERT INTO transcript_revisions(
        id, episode_id, source_id, revision_number, transcript_text, sha256,
        change_note, created_by_pubkey, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    `).run(revisionId, input.episodeId, sourceId, revisionNumber, input.transcriptText, digest, input.changeNote, input.actorPubkey, now);
    db.query(`
      UPDATE episodes
      SET active_transcript_revision_id = ?1, status = 'ready-for-extraction', updated_at = ?2
      WHERE id = ?3
    `).run(revisionId, now, input.episodeId);
    recordAuditEvent({
      actorPubkey: input.actorPubkey,
      action: "transcript.revision.created",
      entityType: "episode",
      entityId: input.episodeId,
      detail: { revisionId, sourceId, revisionNumber, sourceKind: "pasted", sizeBytes: input.sizeBytes, sha256: digest },
    });
  })();
  return getTranscriptRevision(revisionId)!;
}

export function createUploadedTranscriptRevision(input: {
  episodeId: string;
  originalFilename: string;
  mediaType: string;
  sourceBytes: Uint8Array;
  transcriptText: string;
  changeNote: string | null;
  actorPubkey: string;
}): TranscriptRevision {
  const now = Date.now();
  const sourceId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const sourceDigest = bytesToHex(sha256(input.sourceBytes));
  const revisionDigest = hashText(input.transcriptText);
  const nextRow = db.query("SELECT COALESCE(MAX(revision_number), 0) + 1 AS next FROM transcript_revisions WHERE episode_id = ?1")
    .get(input.episodeId) as { next: number };
  const revisionNumber = Number(nextRow.next);
  const episodeDirectory = join(TRANSCRIPT_UPLOAD_DIR, input.episodeId);
  const storagePath = join(episodeDirectory, `${sourceId}.txt`);
  mkdirSync(episodeDirectory, { recursive: true });
  writeFileSync(storagePath, input.sourceBytes);

  try {
    db.transaction(() => {
      db.query(`
        INSERT INTO transcript_sources(
          id, episode_id, source_kind, original_filename, media_type, size_bytes,
          sha256, storage_path, created_by_pubkey, created_at
        ) VALUES (?1, ?2, 'upload', ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      `).run(
        sourceId,
        input.episodeId,
        input.originalFilename,
        input.mediaType,
        input.sourceBytes.byteLength,
        sourceDigest,
        storagePath,
        input.actorPubkey,
        now,
      );
      db.query(`
        INSERT INTO transcript_revisions(
          id, episode_id, source_id, revision_number, transcript_text, sha256,
          change_note, created_by_pubkey, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      `).run(revisionId, input.episodeId, sourceId, revisionNumber, input.transcriptText, revisionDigest, input.changeNote, input.actorPubkey, now);
      db.query(`
        UPDATE episodes
        SET active_transcript_revision_id = ?1, status = 'ready-for-extraction', updated_at = ?2
        WHERE id = ?3
      `).run(revisionId, now, input.episodeId);
      recordAuditEvent({
        actorPubkey: input.actorPubkey,
        action: "transcript.uploaded",
        entityType: "episode",
        entityId: input.episodeId,
        detail: {
          revisionId,
          sourceId,
          revisionNumber,
          originalFilename: input.originalFilename,
          sizeBytes: input.sourceBytes.byteLength,
          sourceSha256: sourceDigest,
          revisionSha256: revisionDigest,
        },
      });
    })();
  } catch (error) {
    try {
      unlinkSync(storagePath);
    } catch {}
    throw error;
  }
  return getTranscriptRevision(revisionId)!;
}

export function getTranscriptRevision(id: string): TranscriptRevision | null {
  const row = db.query(`
    SELECT tr.*, ts.source_kind, ts.size_bytes, ts.original_filename,
           length(CAST(tr.transcript_text AS BLOB)) AS revision_size_bytes
    FROM transcript_revisions tr
    JOIN transcript_sources ts ON ts.id = tr.source_id
    WHERE tr.id = ?1
  `).get(id) as Record<string, unknown> | null;
  return row ? mapTranscriptRevision(row) : null;
}

export function getActiveTranscriptRevision(episodeId: string): TranscriptRevision | null {
  const row = db.query(`
    SELECT tr.*, ts.source_kind, ts.size_bytes, ts.original_filename,
           length(CAST(tr.transcript_text AS BLOB)) AS revision_size_bytes
    FROM episodes e
    JOIN transcript_revisions tr ON tr.id = e.active_transcript_revision_id
    JOIN transcript_sources ts ON ts.id = tr.source_id
    WHERE e.id = ?1
  `).get(episodeId) as Record<string, unknown> | null;
  return row ? mapTranscriptRevision(row) : null;
}

export function listTranscriptRevisions(episodeId: string): Omit<TranscriptRevision, "transcriptText">[] {
  const rows = db.query(`
    SELECT tr.*, ts.source_kind, ts.size_bytes, ts.original_filename,
           length(CAST(tr.transcript_text AS BLOB)) AS revision_size_bytes
    FROM transcript_revisions tr
    JOIN transcript_sources ts ON ts.id = tr.source_id
    WHERE tr.episode_id = ?1
    ORDER BY tr.revision_number DESC
  `).all(episodeId) as Record<string, unknown>[];
  return rows.map(mapTranscriptRevision).map(({ transcriptText: _transcriptText, ...revision }) => revision);
}

export function activateTranscriptRevision(input: {
  episodeId: string;
  revisionId: string;
  actorPubkey: string;
}): TranscriptRevision | null {
  const revision = getTranscriptRevision(input.revisionId);
  if (!revision || revision.episodeId !== input.episodeId) return null;
  const now = Date.now();
  db.transaction(() => {
    db.query(`
      UPDATE episodes
      SET active_transcript_revision_id = ?1, status = 'ready-for-extraction', updated_at = ?2
      WHERE id = ?3
    `).run(input.revisionId, now, input.episodeId);
    recordAuditEvent({
      actorPubkey: input.actorPubkey,
      action: "transcript.revision.activated",
      entityType: "episode",
      entityId: input.episodeId,
      detail: {
        revisionId: revision.id,
        revisionNumber: revision.revisionNumber,
        sourceId: revision.sourceId,
        sourceKind: revision.sourceKind,
        sha256: revision.sha256,
      },
    });
  })();
  return revision;
}

export function listEpisodeAuditEvents(episodeId: string): AuditEvent[] {
  const rows = db.query(`
    SELECT * FROM audit_events
    WHERE entity_type = 'episode' AND entity_id = ?1
    ORDER BY created_at DESC
    LIMIT 100
  `).all(episodeId) as Record<string, unknown>[];
  return rows.map(mapAuditEvent);
}
