import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createPipelineRequest,
  createPipelineRun,
  getPipelineRequestContext,
  getPipelineRequestTranscript,
  listEpisodePipelineRequests,
  markPipelineRunFailed,
  markPipelineRunStarted,
  markStalePipelineRunsTimedOut,
  verifyPreparedPipelineTrigger,
  verifyPipelineRunCallbackToken,
} from "./pipeline-requests.ts";

const databases: Database[] = [];

function testDatabase(): Database {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users(pubkey TEXT PRIMARY KEY);
    CREATE TABLE autopilot_targets(id TEXT PRIMARY KEY);
    CREATE TABLE episodes(
      id TEXT PRIMARY KEY, episode_number INTEGER, working_title TEXT NOT NULL, public_title TEXT,
      recorded_on TEXT, audio_url TEXT, video_url TEXT, owner_pubkey TEXT NOT NULL
    );
    CREATE TABLE transcript_sources(
      id TEXT PRIMARY KEY, source_kind TEXT NOT NULL, original_filename TEXT, size_bytes INTEGER NOT NULL
    );
    CREATE TABLE transcript_revisions(
      id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, source_id TEXT NOT NULL, revision_number INTEGER NOT NULL,
      transcript_text TEXT NOT NULL, sha256 TEXT NOT NULL, change_note TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE snack_candidates(
      id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, current_revision_id TEXT NOT NULL, review_decision TEXT NOT NULL
    );
    CREATE TABLE snack_revisions(
      id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, revision_number INTEGER NOT NULL, public_title TEXT NOT NULL,
      editorial_title TEXT, standfirst TEXT NOT NULL, body_markdown TEXT NOT NULL, structure_exception TEXT,
      claim_evidence_json TEXT NOT NULL DEFAULT '[]', transcript_excerpt TEXT, validation_warnings_json TEXT NOT NULL DEFAULT '[]', pipeline_request_id TEXT
    );
    CREATE TABLE pipeline_requests (
      id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, operation TEXT NOT NULL, status TEXT NOT NULL,
      actor_pubkey TEXT NOT NULL, input_transcript_revision_id TEXT NOT NULL, input_transcript_sha256 TEXT NOT NULL,
      autopilot_target_id TEXT NOT NULL, pipeline_name TEXT NOT NULL, pipeline_version TEXT,
      prompt_suite_version TEXT NOT NULL, result_schema_version TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
      attempt_count INTEGER NOT NULL DEFAULT 0, result_applied_at INTEGER, failure_summary TEXT,
      target_candidate_id TEXT, base_candidate_revision_id TEXT, regeneration_instruction TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE pipeline_runs (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, status TEXT NOT NULL,
      autopilot_run_id TEXT, callback_token_hash TEXT NOT NULL, trigger_payload_json TEXT,
      failure_category TEXT, failure_summary TEXT, retry_of_run_id TEXT, triggered_at INTEGER,
      completed_at INTEGER, progress_percent INTEGER NOT NULL DEFAULT 0, progress_label TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(request_id, attempt_number)
    );
    CREATE TABLE pipeline_artifacts(id TEXT PRIMARY KEY, request_id TEXT NOT NULL, artifact_type TEXT NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
  database.query("INSERT INTO users(pubkey) VALUES ('editor')").run();
  database.query("INSERT INTO autopilot_targets(id) VALUES ('rick')").run();
  database.query("INSERT INTO episodes(id, episode_number, working_title, public_title, recorded_on, owner_pubkey) VALUES ('episode-64', 64, 'Working', 'Public', '2026-08-01', 'editor')").run();
  database.query("INSERT INTO transcript_sources(id, source_kind, original_filename, size_bytes) VALUES ('source-1', 'upload', 'episode-64.txt', 23)").run();
  database.query("INSERT INTO transcript_revisions(id, episode_id, source_id, revision_number, transcript_text, sha256, created_at) VALUES ('revision-1', 'episode-64', 'source-1', 1, 'The immutable transcript', 'digest-1', 100)").run();
  return database;
}

afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

describe("episode pipeline lifecycle", () => {
  test("pins a request to an immutable transcript and exposes scoped context", () => {
    const database = testDatabase();
    const request = createPipelineRequest({
      episodeId: "episode-64",
      actorPubkey: "editor",
      transcriptRevisionId: "revision-1",
      autopilotTargetId: "rick",
      pipelineName: "snack-studio-transcript-to-snacks",
      idempotencyKey: "episode-64-revision-1-v2",
    }, database);

    expect(request.inputTranscriptSha256).toBe("digest-1");
    expect(request.promptSuiteVersion).toBe("v3-intelligence-snacks-natural-prose");
    expect(getPipelineRequestContext(request.id, database)?.transcript).toMatchObject({ id: "revision-1", sha256: "digest-1" });
    expect(getPipelineRequestTranscript(request.id, database)).toMatchObject({
      requestId: request.id,
      transcriptRevisionId: "revision-1",
      transcriptText: "The immutable transcript",
    });
  });

  test("pins targeted regeneration to the current Snack revision", () => {
    const database = testDatabase();
    database.query("INSERT INTO snack_candidates VALUES ('candidate-1', 'episode-64', 'snack-revision-2', 'accepted')").run();
    database.query("INSERT INTO snack_revisions VALUES ('snack-revision-2', 'candidate-1', 2, 'Public title', 'Editorial title', 'Standfirst', 'Paragraph one', NULL, '[{\"claim\":\"Claim\",\"evidenceIds\":[\"evidence-1\"]}]', 'Exact evidence', '[]', NULL)").run();
    const request = createPipelineRequest({
      episodeId: "episode-64", operation: "snack-regeneration", actorPubkey: "editor",
      transcriptRevisionId: "revision-1", autopilotTargetId: "rick",
      pipelineName: "snack-studio-regenerate-snack", targetCandidateId: "candidate-1",
      regenerationInstruction: "Make the title more concrete",
    }, database);
    const context = getPipelineRequestContext(request.id, database);
    expect(request).toMatchObject({ targetCandidateId: "candidate-1", baseCandidateRevisionId: "snack-revision-2" });
    expect(context?.targetCandidate).toMatchObject({
      id: "candidate-1", baseRevisionId: "snack-revision-2", publicTitle: "Public title",
      instruction: "Make the title more concrete",
    });
  });

  test("stores only a callback-token hash and preserves retry lineage", () => {
    const database = testDatabase();
    const request = createPipelineRequest({
      episodeId: "episode-64",
      actorPubkey: "editor",
      transcriptRevisionId: "revision-1",
      autopilotTargetId: "rick",
      pipelineName: "pipeline-v2",
    }, database);
    const first = createPipelineRun({ requestId: request.id }, database);
    const retry = createPipelineRun({ requestId: request.id, retryOfRunId: first.run.id }, database);

    expect(first.run).not.toHaveProperty("callbackToken");
    expect(verifyPipelineRunCallbackToken(first.run.id, first.callbackToken, database)).toBe(true);
    expect(verifyPipelineRunCallbackToken(first.run.id, "wrong-token", database)).toBe(false);
    expect(retry.run).toMatchObject({ attemptNumber: 2, retryOfRunId: first.run.id });
    expect(listEpisodePipelineRequests("episode-64", database)[0]).toMatchObject({ attemptCount: 2 });
  });

  test("stores a redacted trigger and verifies the exact ephemeral payload", () => {
    const database = testDatabase();
    const request = createPipelineRequest({
      episodeId: "episode-64",
      actorPubkey: "editor",
      transcriptRevisionId: "revision-1",
      autopilotTargetId: "rick",
      pipelineName: "pipeline-v2",
    }, database);
    const prepared = createPipelineRun({
      requestId: request.id,
      buildTriggerPayload: (token) => ({
        url: "https://autopilot.example/api/pipelines/triggers/http/pipeline-v2",
        method: "POST",
        body: { input: {
          requestId: request.id,
          localContext: { references: [{ type: "pipeline-context", url: "https://studio.example/context", authorization: "" }] },
          webhook: { token },
        } },
      }),
    }, database);

    expect(JSON.stringify(prepared.run.triggerPayload)).not.toContain(prepared.callbackToken);
    expect(prepared.run.triggerPayload).toMatchObject({ body: { input: { webhook: { token: "[redacted]" } } } });
    expect(prepared.run.triggerPayload).toMatchObject({ body: { input: { localContext: { references: [{ authorization: "[ephemeral]" }] } } } });
    const delegatedPayload = structuredClone(prepared.triggerPayload!);
    (((delegatedPayload.body as Record<string, unknown>).input as Record<string, unknown>).localContext as { references: Array<Record<string, unknown>> })
      .references[0]!.authorization = "Nostr signed-event";
    expect(verifyPreparedPipelineTrigger(prepared.run.id, delegatedPayload, database)).toBe(true);
    expect(verifyPreparedPipelineTrigger(prepared.run.id, {
      ...prepared.triggerPayload,
      url: "https://attacker.example/trigger",
    }, database)).toBe(false);
  });

  test("associates a remote run and records an honest trigger failure", () => {
    const database = testDatabase();
    const request = createPipelineRequest({
      episodeId: "episode-64",
      actorPubkey: "editor",
      transcriptRevisionId: "revision-1",
      autopilotTargetId: "rick",
      pipelineName: "pipeline-v2",
    }, database);
    const startedAttempt = createPipelineRun({ requestId: request.id }, database);
    expect(markPipelineRunStarted({ runId: startedAttempt.run.id, autopilotRunId: "remote-1", remoteStatus: "running" }, database))
      .toMatchObject({ status: "running", autopilotRunId: "remote-1" });

    const retry = createPipelineRun({ requestId: request.id, retryOfRunId: startedAttempt.run.id }, database);
    expect(markPipelineRunFailed({ runId: retry.run.id, category: "trigger-failed", summary: "Pipeline unavailable" }, database))
      .toMatchObject({ status: "error", failureCategory: "trigger-failed", failureSummary: "Pipeline unavailable" });
    expect(listEpisodePipelineRequests("episode-64", database)[0]).toMatchObject({ status: "failed", failureSummary: "Pipeline unavailable" });
  });

  test("rejects a transcript from another episode", () => {
    const database = testDatabase();
    expect(() => createPipelineRequest({
      episodeId: "another-episode",
      actorPubkey: "editor",
      transcriptRevisionId: "revision-1",
      autopilotTargetId: "rick",
      pipelineName: "pipeline-v2",
    }, database)).toThrow("active transcript revision not found for episode");
  });

  test("returns the same request for a repeated idempotency key", () => {
    const database = testDatabase();
    const input = {
      episodeId: "episode-64",
      actorPubkey: "editor",
      transcriptRevisionId: "revision-1",
      autopilotTargetId: "rick",
      pipelineName: "pipeline-v2",
      idempotencyKey: "stable-editor-intent",
    };
    const first = createPipelineRequest(input, database);
    const repeated = createPipelineRequest(input, database);
    expect(repeated.id).toBe(first.id);
    expect(listEpisodePipelineRequests("episode-64", database)).toHaveLength(1);
  });

  test("marks an overdue run timed out without treating it as remote cancellation", () => {
    const database = testDatabase();
    const request = createPipelineRequest({
      episodeId: "episode-64", actorPubkey: "editor", transcriptRevisionId: "revision-1",
      autopilotTargetId: "rick", pipelineName: "pipeline-v2",
    }, database);
    const prepared = createPipelineRun({ requestId: request.id }, database);
    markPipelineRunStarted({ runId: prepared.run.id, autopilotRunId: "remote-timeout", remoteStatus: "running" }, database);
    database.query("UPDATE pipeline_runs SET triggered_at = 100, updated_at = 100 WHERE id = ?1").run(prepared.run.id);
    expect(markStalePipelineRunsTimedOut({ episodeId: "episode-64", timeoutMs: 500, now: 1000 }, database)).toBe(1);
    expect(listEpisodePipelineRequests("episode-64", database)[0]).toMatchObject({
      status: "timed-out",
      runs: [{ status: "timed-out", autopilotRunId: "remote-timeout" }],
    });
  });
});
