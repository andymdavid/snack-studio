import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createPipelineRequest, createPipelineRun, markPipelineRunStarted, markStalePipelineRunsTimedOut } from "./pipeline-requests.ts";
import { validateSuccessfulPipelineResult } from "./pipeline-result-input.ts";
import { validPipelineCallback } from "./pipeline-result-fixture.ts";
import { applySuccessfulPipelineResult } from "./pipeline-results.ts";

const databases: Database[] = [];

function testDatabase(): Database {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE users(pubkey TEXT PRIMARY KEY);
    CREATE TABLE autopilot_targets(id TEXT PRIMARY KEY);
    CREATE TABLE episodes(id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE transcript_revisions(id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, sha256 TEXT NOT NULL);
    CREATE TABLE pipeline_requests(
      id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, operation TEXT NOT NULL, status TEXT NOT NULL,
      actor_pubkey TEXT NOT NULL, input_transcript_revision_id TEXT NOT NULL, input_transcript_sha256 TEXT NOT NULL,
      autopilot_target_id TEXT NOT NULL, pipeline_name TEXT NOT NULL, pipeline_version TEXT,
      prompt_suite_version TEXT NOT NULL, result_schema_version TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
      attempt_count INTEGER NOT NULL DEFAULT 0, result_applied_at INTEGER, failure_summary TEXT,
      target_candidate_id TEXT, base_candidate_revision_id TEXT, regeneration_instruction TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE pipeline_runs(
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, status TEXT NOT NULL,
      autopilot_run_id TEXT UNIQUE, callback_token_hash TEXT NOT NULL, trigger_payload_json TEXT,
      failure_category TEXT, failure_summary TEXT, retry_of_run_id TEXT, triggered_at INTEGER,
      completed_at INTEGER, progress_percent INTEGER NOT NULL DEFAULT 0, progress_label TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(request_id, attempt_number)
    );
    CREATE TABLE pipeline_artifacts(
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL, run_id TEXT, artifact_type TEXT NOT NULL,
      schema_version TEXT NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE snack_candidates(
      id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, review_decision TEXT NOT NULL, current_revision_id TEXT,
      pipeline_request_id TEXT, selection_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(pipeline_request_id, selection_id)
    );
    CREATE TABLE snack_revisions(
      id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, revision_number INTEGER NOT NULL, public_title TEXT NOT NULL,
      editorial_title TEXT, standfirst TEXT NOT NULL, body_markdown TEXT NOT NULL, related_topics_json TEXT NOT NULL,
      transcript_timestamp TEXT, transcript_excerpt TEXT,
      public_state TEXT NOT NULL, origin TEXT NOT NULL, change_note TEXT, created_at INTEGER NOT NULL,
      pipeline_request_id TEXT, pipeline_run_id TEXT, source_transcript_revision_id TEXT, prompt_suite_version TEXT,
      pipeline_version TEXT, result_schema_version TEXT, structure_exception TEXT, claim_evidence_json TEXT NOT NULL,
      validation_warnings_json TEXT NOT NULL
    );
  `);
  database.query("INSERT INTO users VALUES ('editor')").run();
  database.query("INSERT INTO autopilot_targets VALUES ('rick')").run();
  database.query("INSERT INTO episodes VALUES ('episode-64', 'processing', 1)").run();
  database.query("INSERT INTO transcript_revisions VALUES ('revision-1', 'episode-64', 'digest-1')").run();
  return database;
}

function prepared(database: Database) {
  const request = createPipelineRequest({
    episodeId: "episode-64", actorPubkey: "editor", transcriptRevisionId: "revision-1",
    autopilotTargetId: "rick", pipelineName: "pipeline-v2", idempotencyKey: "request-key",
  }, database);
  database.query("UPDATE pipeline_requests SET id = 'request-1' WHERE id = ?1").run(request.id);
  const run = createPipelineRun({ requestId: "request-1" }, database);
  markPipelineRunStarted({ runId: run.run.id, autopilotRunId: "remote-run-1", remoteStatus: "running" }, database);
  return run.run.id;
}

afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

describe("pipeline result application", () => {
  test("inserts candidates and artifacts in one transaction and treats replay idempotently", () => {
    const database = testDatabase();
    const localRunId = prepared(database);
    const validation = validateSuccessfulPipelineResult(validPipelineCallback());
    if (!validation.ok) throw new Error(validation.error);
    expect(applySuccessfulPipelineResult({ localRunId, result: validation.value }, database)).toEqual({ replay: false, candidateCount: 6 });
    expect(database.query("SELECT COUNT(*) AS count FROM snack_candidates").get()).toEqual({ count: 6 });
    expect(database.query("SELECT COUNT(*) AS count FROM pipeline_artifacts").get()).toEqual({ count: 3 });
    expect(database.query("SELECT status FROM pipeline_requests WHERE id = 'request-1'").get()).toEqual({ status: "completed" });
    expect(applySuccessfulPipelineResult({ localRunId, result: validation.value }, database)).toEqual({ replay: true, candidateCount: 6 });
    expect(database.query("SELECT COUNT(*) AS count FROM snack_candidates").get()).toEqual({ count: 6 });
  });

  test("rejects mismatched provenance before inserting candidates", () => {
    const database = testDatabase();
    const localRunId = prepared(database);
    const body = validPipelineCallback();
    body.inputRevisionId = "revision-other";
    const validation = validateSuccessfulPipelineResult(body);
    if (!validation.ok) throw new Error(validation.error);
    expect(() => applySuccessfulPipelineResult({ localRunId, result: validation.value }, database)).toThrow("pipeline callback transcript revision mismatch");
    expect(database.query("SELECT COUNT(*) AS count FROM snack_candidates").get()).toEqual({ count: 0 });
  });

  test("rolls back artifacts and earlier candidates when any insert fails", () => {
    const database = testDatabase();
    const localRunId = prepared(database);
    database.query(`
      INSERT INTO snack_candidates(id, episode_id, review_decision, pipeline_request_id, selection_id, created_at, updated_at)
      VALUES ('existing', 'episode-64', 'generated', 'request-1', 'selection-2', 1, 1)
    `).run();
    const validation = validateSuccessfulPipelineResult(validPipelineCallback());
    if (!validation.ok) throw new Error(validation.error);
    expect(() => applySuccessfulPipelineResult({ localRunId, result: validation.value }, database)).toThrow();
    expect(database.query("SELECT COUNT(*) AS count FROM snack_candidates").get()).toEqual({ count: 1 });
    expect(database.query("SELECT COUNT(*) AS count FROM pipeline_artifacts").get()).toEqual({ count: 0 });
    expect(database.query("SELECT status FROM pipeline_requests WHERE id = 'request-1'").get()).toEqual({ status: "running" });
  });

  test("accepts a late authoritative callback after the local timeout", () => {
    const database = testDatabase();
    const localRunId = prepared(database);
    database.query("UPDATE pipeline_runs SET triggered_at = 100, updated_at = 100 WHERE id = ?1").run(localRunId);
    expect(markStalePipelineRunsTimedOut({ episodeId: "episode-64", timeoutMs: 500, now: 1000 }, database)).toBe(1);
    const validation = validateSuccessfulPipelineResult(validPipelineCallback());
    if (!validation.ok) throw new Error(validation.error);
    expect(applySuccessfulPipelineResult({ localRunId, result: validation.value }, database)).toEqual({ replay: false, candidateCount: 6 });
    expect(database.query("SELECT status, failure_summary FROM pipeline_requests WHERE id = 'request-1'").get())
      .toEqual({ status: "completed", failure_summary: null });
    expect(database.query("SELECT status, failure_category FROM pipeline_runs WHERE id = ?1").get(localRunId))
      .toEqual({ status: "complete", failure_category: null });
  });
});
