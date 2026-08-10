import type { Database } from "bun:sqlite";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { db as appDb } from "./db.ts";

export const PIPELINE_OPERATIONS = ["transcript-to-snacks", "transcript-normalization"] as const;
export type PipelineOperation = typeof PIPELINE_OPERATIONS[number];

export const PIPELINE_REQUEST_STATUSES = [
  "created", "awaiting-authorization", "queued", "running", "applying-result",
  "completed", "failed", "timed-out", "needs-review", "cancelled",
] as const;
export type PipelineRequestStatus = typeof PIPELINE_REQUEST_STATUSES[number];

export const PIPELINE_RUN_STATUSES = [
  "prepared", "awaiting-authorization", "triggering", "queued", "running",
  "complete", "error", "timed-out", "cancelled",
] as const;
export type PipelineRunStatus = typeof PIPELINE_RUN_STATUSES[number];

export type PipelineRequest = {
  id: string;
  episodeId: string;
  operation: PipelineOperation;
  status: PipelineRequestStatus;
  actorPubkey: string;
  inputTranscriptRevisionId: string;
  inputTranscriptSha256: string;
  autopilotTargetId: string;
  pipelineName: string;
  pipelineVersion: string | null;
  promptSuiteVersion: string;
  resultSchemaVersion: string;
  idempotencyKey: string;
  attemptCount: number;
  resultAppliedAt: number | null;
  failureSummary: string | null;
  createdAt: number;
  updatedAt: number;
};

export type PipelineRun = {
  id: string;
  requestId: string;
  attemptNumber: number;
  status: PipelineRunStatus;
  autopilotRunId: string | null;
  triggerPayload: Record<string, unknown> | null;
  failureCategory: string | null;
  failureSummary: string | null;
  progressPercent: number;
  progressLabel: string | null;
  retryOfRunId: string | null;
  triggeredAt: number | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function mapRequest(row: Record<string, unknown>): PipelineRequest {
  return {
    id: String(row.id),
    episodeId: String(row.episode_id),
    operation: String(row.operation) as PipelineOperation,
    status: String(row.status) as PipelineRequestStatus,
    actorPubkey: String(row.actor_pubkey),
    inputTranscriptRevisionId: String(row.input_transcript_revision_id),
    inputTranscriptSha256: String(row.input_transcript_sha256),
    autopilotTargetId: String(row.autopilot_target_id),
    pipelineName: String(row.pipeline_name),
    pipelineVersion: row.pipeline_version == null ? null : String(row.pipeline_version),
    promptSuiteVersion: String(row.prompt_suite_version),
    resultSchemaVersion: String(row.result_schema_version),
    idempotencyKey: String(row.idempotency_key),
    attemptCount: Number(row.attempt_count),
    resultAppliedAt: row.result_applied_at == null ? null : Number(row.result_applied_at),
    failureSummary: row.failure_summary == null ? null : String(row.failure_summary),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapRun(row: Record<string, unknown>): PipelineRun {
  return {
    id: String(row.id),
    requestId: String(row.request_id),
    attemptNumber: Number(row.attempt_number),
    status: String(row.status) as PipelineRunStatus,
    autopilotRunId: row.autopilot_run_id == null ? null : String(row.autopilot_run_id),
    triggerPayload: parseObject(row.trigger_payload_json),
    failureCategory: row.failure_category == null ? null : String(row.failure_category),
    failureSummary: row.failure_summary == null ? null : String(row.failure_summary),
    progressPercent: Math.max(0, Math.min(100, Number(row.progress_percent || 0))),
    progressLabel: row.progress_label == null ? null : String(row.progress_label),
    retryOfRunId: row.retry_of_run_id == null ? null : String(row.retry_of_run_id),
    triggeredAt: row.triggered_at == null ? null : Number(row.triggered_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function tokenHash(token: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(token)));
}

export function createPipelineRequest(input: {
  episodeId: string;
  operation?: PipelineOperation;
  actorPubkey: string;
  transcriptRevisionId: string;
  autopilotTargetId: string;
  pipelineName: string;
  pipelineVersion?: string | null;
  promptSuiteVersion?: string;
  resultSchemaVersion?: string;
  idempotencyKey?: string;
}, database: Database = appDb): PipelineRequest {
  const transcript = database.query("SELECT episode_id, sha256 FROM transcript_revisions WHERE id = ?1").get(input.transcriptRevisionId) as
    | { episode_id: string; sha256: string }
    | null;
  if (!transcript || transcript.episode_id !== input.episodeId) throw new Error("active transcript revision not found for episode");
  if (input.idempotencyKey) {
    const existingRow = database.query("SELECT * FROM pipeline_requests WHERE idempotency_key = ?1").get(input.idempotencyKey) as Record<string, unknown> | null;
    if (existingRow) {
      const existing = mapRequest(existingRow);
      if (
        existing.episodeId !== input.episodeId
        || existing.operation !== (input.operation || "transcript-to-snacks")
        || existing.inputTranscriptRevisionId !== input.transcriptRevisionId
      ) throw new Error("idempotency key is already used by another pipeline request");
      return existing;
    }
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  database.query(`
    INSERT INTO pipeline_requests(
      id, episode_id, operation, status, actor_pubkey, input_transcript_revision_id,
      input_transcript_sha256, autopilot_target_id, pipeline_name, pipeline_version,
      prompt_suite_version, result_schema_version, idempotency_key, created_at, updated_at
    ) VALUES (?1, ?2, ?3, 'created', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
  `).run(
    id,
    input.episodeId,
    input.operation || "transcript-to-snacks",
    input.actorPubkey,
    input.transcriptRevisionId,
    transcript.sha256,
    input.autopilotTargetId,
    input.pipelineName,
    input.pipelineVersion ?? null,
    input.promptSuiteVersion || "v3-intelligence-snacks-natural-prose",
    input.resultSchemaVersion || "1",
    input.idempotencyKey || crypto.randomUUID(),
    now,
  );
  return getPipelineRequest(id, database)!;
}

export function getPipelineRequest(id: string, database: Database = appDb): PipelineRequest | null {
  const row = database.query("SELECT * FROM pipeline_requests WHERE id = ?1").get(id) as Record<string, unknown> | null;
  return row ? mapRequest(row) : null;
}

export function listEpisodePipelineRequests(episodeId: string, database: Database = appDb): Array<PipelineRequest & { runs: PipelineRun[] }> {
  const rows = database.query("SELECT * FROM pipeline_requests WHERE episode_id = ?1 ORDER BY created_at DESC").all(episodeId) as Record<string, unknown>[];
  return rows.map((row) => {
    const request = mapRequest(row);
    return { ...request, runs: listPipelineRuns(request.id, database) };
  });
}

export function createPipelineRun(input: {
  requestId: string;
  retryOfRunId?: string | null;
  triggerPayload?: Record<string, unknown> | null;
  buildTriggerPayload?: (callbackToken: string, runId: string) => Record<string, unknown>;
}, database: Database = appDb): { run: PipelineRun; callbackToken: string; triggerPayload: Record<string, unknown> | null } {
  const request = getPipelineRequest(input.requestId, database);
  if (!request) throw new Error("pipeline request not found");
  const callbackToken = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  const runId = crypto.randomUUID();
  const now = Date.now();
  const attemptNumber = request.attemptCount + 1;
  const triggerPayload = input.buildTriggerPayload?.(callbackToken, runId) || input.triggerPayload || null;
  const storedTriggerPayload = triggerPayload ? structuredClone(triggerPayload) : null;
  const storedInput = storedTriggerPayload?.body && typeof storedTriggerPayload.body === "object"
    ? (storedTriggerPayload.body as Record<string, unknown>).input
    : null;
  const storedWebhook = storedInput && typeof storedInput === "object"
    ? (storedInput as Record<string, unknown>).webhook
    : null;
  if (storedWebhook && typeof storedWebhook === "object") (storedWebhook as Record<string, unknown>).token = "[redacted]";
  redactContextAuthorizations(storedInput);
  database.transaction(() => {
    database.query(`
      INSERT INTO pipeline_runs(
        id, request_id, attempt_number, status, callback_token_hash, trigger_payload_json,
        retry_of_run_id, created_at, updated_at
      ) VALUES (?1, ?2, ?3, 'awaiting-authorization', ?4, ?5, ?6, ?7, ?7)
    `).run(
      runId,
      request.id,
      attemptNumber,
      tokenHash(callbackToken),
      storedTriggerPayload ? JSON.stringify(storedTriggerPayload) : null,
      input.retryOfRunId ?? null,
      now,
    );
    database.query("UPDATE pipeline_requests SET status = 'awaiting-authorization', attempt_count = ?1, updated_at = ?2 WHERE id = ?3")
      .run(attemptNumber, now, request.id);
  })();
  return { run: getPipelineRun(runId, database)!, callbackToken, triggerPayload };
}

export function markPipelineRunStarted(input: {
  runId: string;
  autopilotRunId: string;
  remoteStatus?: string;
}, database: Database = appDb): PipelineRun {
  const run = getPipelineRun(input.runId, database);
  if (!run) throw new Error("pipeline run not found");
  const now = Date.now();
  const status: PipelineRunStatus = input.remoteStatus === "running" ? "running" : "queued";
  database.transaction(() => {
    database.query(`
      UPDATE pipeline_runs
      SET status = ?1, autopilot_run_id = ?2, triggered_at = COALESCE(triggered_at, ?3), updated_at = ?3
      WHERE id = ?4
    `).run(status, input.autopilotRunId, now, run.id);
    database.query("UPDATE pipeline_requests SET status = ?1, failure_summary = NULL, updated_at = ?2 WHERE id = ?3")
      .run(status, now, run.requestId);
  })();
  return getPipelineRun(run.id, database)!;
}

export function markPipelineRunFailed(input: {
  runId: string;
  category: string;
  summary: string;
}, database: Database = appDb): PipelineRun {
  const run = getPipelineRun(input.runId, database);
  if (!run) throw new Error("pipeline run not found");
  const now = Date.now();
  const safeSummary = input.summary.slice(0, 1000);
  database.transaction(() => {
    database.query(`
      UPDATE pipeline_runs
      SET status = 'error', failure_category = ?1, failure_summary = ?2, completed_at = ?3, updated_at = ?3
      WHERE id = ?4
    `).run(input.category.slice(0, 80), safeSummary, now, run.id);
    database.query("UPDATE pipeline_requests SET status = 'failed', failure_summary = ?1, updated_at = ?2 WHERE id = ?3")
      .run(safeSummary, now, run.requestId);
  })();
  return getPipelineRun(run.id, database)!;
}

export function updatePipelineRunProgress(input: {
  runId: string;
  percent: number;
  label: string;
}, database: Database = appDb): PipelineRun {
  const run = getPipelineRun(input.runId, database);
  if (!run) throw new Error("pipeline run not found");
  if (!["queued", "running"].includes(run.status)) return run;
  const percent = Math.max(run.progressPercent, Math.min(99, Math.round(input.percent)));
  const label = input.label.trim().slice(0, 120);
  database.query(`
    UPDATE pipeline_runs SET progress_percent = ?1, progress_label = ?2, updated_at = ?3 WHERE id = ?4
  `).run(percent, label || null, Date.now(), run.id);
  return getPipelineRun(run.id, database)!;
}

export function markPipelineResultRejected(input: {
  runId: string;
  summary: string;
}, database: Database = appDb): PipelineRun {
  const run = getPipelineRun(input.runId, database);
  if (!run) throw new Error("pipeline run not found");
  const now = Date.now();
  const safeSummary = input.summary.slice(0, 1000);
  database.transaction(() => {
    database.query(`
      UPDATE pipeline_runs
      SET status = 'error', failure_category = 'result-validation', failure_summary = ?1,
          completed_at = ?2, updated_at = ?2
      WHERE id = ?3
    `).run(safeSummary, now, run.id);
    database.query("UPDATE pipeline_requests SET status = 'needs-review', failure_summary = ?1, updated_at = ?2 WHERE id = ?3")
      .run(safeSummary, now, run.requestId);
  })();
  return getPipelineRun(run.id, database)!;
}

export function getPipelineRun(id: string, database: Database = appDb): PipelineRun | null {
  const row = database.query("SELECT * FROM pipeline_runs WHERE id = ?1").get(id) as Record<string, unknown> | null;
  return row ? mapRun(row) : null;
}

export function listPipelineRuns(requestId: string, database: Database = appDb): PipelineRun[] {
  const rows = database.query("SELECT * FROM pipeline_runs WHERE request_id = ?1 ORDER BY attempt_number DESC").all(requestId) as Record<string, unknown>[];
  return rows.map(mapRun);
}

export function cancelUnstartedPipelineRuns(requestId: string, database: Database = appDb): number {
  const now = Date.now();
  const result = database.query(`
    UPDATE pipeline_runs
    SET status = 'cancelled', completed_at = ?1, updated_at = ?1
    WHERE request_id = ?2 AND status IN ('prepared', 'awaiting-authorization')
  `).run(now, requestId);
  return Number(result.changes);
}

export function markStalePipelineRunsTimedOut(input: {
  episodeId: string;
  timeoutMs: number;
  now?: number;
}, database: Database = appDb): number {
  const now = input.now ?? Date.now();
  const cutoff = now - input.timeoutMs;
  const rows = database.query(`
    SELECT r.id, r.request_id
    FROM pipeline_runs r
    JOIN pipeline_requests pr ON pr.id = r.request_id
    WHERE pr.episode_id = ?1
      AND r.status IN ('queued', 'running')
      AND COALESCE(r.triggered_at, r.updated_at) < ?2
  `).all(input.episodeId, cutoff) as Array<{ id: string; request_id: string }>;
  if (!rows.length) return 0;
  database.transaction(() => {
    for (const row of rows) {
      database.query(`
        UPDATE pipeline_runs
        SET status = 'timed-out', failure_category = 'timeout',
            failure_summary = 'No authoritative callback arrived before the local timeout',
            completed_at = ?1, updated_at = ?1
        WHERE id = ?2 AND status IN ('queued', 'running')
      `).run(now, row.id);
      database.query(`
        UPDATE pipeline_requests
        SET status = 'timed-out', failure_summary = 'No authoritative callback arrived before the local timeout', updated_at = ?1
        WHERE id = ?2 AND status IN ('queued', 'running')
      `).run(now, row.request_id);
    }
  })();
  return rows.length;
}

export function verifyPipelineRunCallbackToken(runId: string, callbackToken: string, database: Database = appDb): boolean {
  const row = database.query("SELECT callback_token_hash FROM pipeline_runs WHERE id = ?1").get(runId) as { callback_token_hash: string } | null;
  return Boolean(row && callbackToken && row.callback_token_hash === tokenHash(callbackToken));
}

export function findPipelineRunForCallback(requestId: string, callbackToken: string, database: Database = appDb): PipelineRun | null {
  if (!callbackToken) return null;
  const hash = tokenHash(callbackToken);
  const row = database.query("SELECT * FROM pipeline_runs WHERE request_id = ?1 AND callback_token_hash = ?2 ORDER BY attempt_number DESC LIMIT 1")
    .get(requestId, hash) as Record<string, unknown> | null;
  return row ? mapRun(row) : null;
}

export function verifyPreparedPipelineTrigger(runId: string, triggerPayload: Record<string, unknown>, database: Database = appDb): boolean {
  const run = getPipelineRun(runId, database);
  if (!run?.triggerPayload) return false;
  const supplied = structuredClone(triggerPayload);
  const suppliedInput = supplied.body && typeof supplied.body === "object" ? (supplied.body as Record<string, unknown>).input : null;
  const suppliedWebhook = suppliedInput && typeof suppliedInput === "object" ? (suppliedInput as Record<string, unknown>).webhook : null;
  if (!suppliedWebhook || typeof suppliedWebhook !== "object") return false;
  const callbackToken = String((suppliedWebhook as Record<string, unknown>).token || "");
  if (!verifyPipelineRunCallbackToken(runId, callbackToken, database)) return false;
  (suppliedWebhook as Record<string, unknown>).token = "[redacted]";
  redactContextAuthorizations(suppliedInput);
  return JSON.stringify(supplied) === JSON.stringify(run.triggerPayload);
}

function redactContextAuthorizations(input: unknown): void {
  if (!input || typeof input !== "object") return;
  const localContext = (input as Record<string, unknown>).localContext;
  if (!localContext || typeof localContext !== "object") return;
  const references = (localContext as Record<string, unknown>).references;
  if (!Array.isArray(references)) return;
  for (const reference of references) {
    if (reference && typeof reference === "object") {
      (reference as Record<string, unknown>).authorization = "[ephemeral]";
    }
  }
}

export function getPipelineRequestContext(requestId: string, database: Database = appDb) {
  const row = database.query(`
    SELECT pr.*, e.episode_number, e.working_title, e.public_title, e.recorded_on,
           e.audio_url, e.video_url, tr.revision_number, tr.sha256 AS current_transcript_sha256,
           tr.change_note, tr.created_at AS transcript_created_at, ts.source_kind,
           ts.original_filename, length(CAST(tr.transcript_text AS BLOB)) AS transcript_size_bytes
    FROM pipeline_requests pr
    JOIN episodes e ON e.id = pr.episode_id
    JOIN transcript_revisions tr ON tr.id = pr.input_transcript_revision_id
    JOIN transcript_sources ts ON ts.id = tr.source_id
    WHERE pr.id = ?1
  `).get(requestId) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    request: mapRequest(row),
    episode: {
      id: String(row.episode_id),
      episodeNumber: row.episode_number == null ? null : Number(row.episode_number),
      workingTitle: String(row.working_title),
      publicTitle: row.public_title == null ? null : String(row.public_title),
      recordedOn: row.recorded_on == null ? null : String(row.recorded_on),
      audioUrl: row.audio_url == null ? null : String(row.audio_url),
      videoUrl: row.video_url == null ? null : String(row.video_url),
    },
    transcript: {
      id: String(row.input_transcript_revision_id),
      revisionNumber: Number(row.revision_number),
      sha256: String(row.current_transcript_sha256),
      sizeBytes: Number(row.transcript_size_bytes),
      sourceKind: String(row.source_kind),
      originalFilename: row.original_filename == null ? null : String(row.original_filename),
      changeNote: row.change_note == null ? null : String(row.change_note),
      createdAt: Number(row.transcript_created_at),
    },
    contributors: [],
  };
}

export function getPipelineRequestTranscript(requestId: string, database: Database = appDb) {
  const row = database.query(`
    SELECT pr.id AS request_id, pr.episode_id, pr.input_transcript_revision_id,
           pr.input_transcript_sha256, tr.revision_number, tr.transcript_text, tr.sha256
    FROM pipeline_requests pr
    JOIN transcript_revisions tr ON tr.id = pr.input_transcript_revision_id
    WHERE pr.id = ?1
  `).get(requestId) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    requestId: String(row.request_id),
    episodeId: String(row.episode_id),
    transcriptRevisionId: String(row.input_transcript_revision_id),
    revisionNumber: Number(row.revision_number),
    sha256: String(row.sha256),
    transcriptText: String(row.transcript_text),
  };
}
