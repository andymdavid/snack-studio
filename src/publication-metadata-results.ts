import type { Database } from "bun:sqlite";
import { db as appDb } from "./db.ts";
import { getPipelineRequest, getPipelineRun } from "./pipeline-requests.ts";
import { resolveCanonicalTopic } from "./publication-metadata.ts";
import type { SuccessfulPublicationMetadataResult } from "./publication-metadata-result-input.ts";

export function applySuccessfulPublicationMetadataResult(input: {
  localRunId: string;
  result: SuccessfulPublicationMetadataResult;
}, database: Database = appDb): { replay: boolean; assignmentCount: number } {
  const request = getPipelineRequest(input.result.requestId, database);
  const run = getPipelineRun(input.localRunId, database);
  if (!request || !run || run.requestId !== request.id) throw new Error("pipeline callback target not found");
  if (request.status === "completed" && request.resultAppliedAt) {
    const count = database.query("SELECT COUNT(*) AS count FROM publication_snack_metadata WHERE pipeline_request_id = ?1").get(request.id) as { count: number };
    return { replay: true, assignmentCount: Number(count.count) };
  }
  if (request.operation !== "publication-metadata" || input.result.operation !== request.operation) throw new Error("pipeline callback operation mismatch");
  if (request.episodeId !== input.result.episodeId) throw new Error("pipeline callback episode mismatch");
  if (request.inputTranscriptRevisionId !== input.result.inputRevisionId) throw new Error("pipeline callback transcript revision mismatch");
  if (request.resultSchemaVersion !== input.result.resultSchemaVersion) throw new Error("pipeline callback result schema mismatch");
  if (run.autopilotRunId && input.result.runId && run.autopilotRunId !== input.result.runId) throw new Error("pipeline callback Autopilot run mismatch");

  const approvedRows = database.query(`
    SELECT c.id AS candidate_id, c.current_revision_id
    FROM snack_candidates c
    WHERE c.episode_id = ?1 AND c.review_decision = 'accepted'
    ORDER BY c.approved_position ASC
  `).all(request.episodeId) as Array<{ candidate_id: string; current_revision_id: string }>;
  if (approvedRows.length !== input.result.assignments.length) throw new Error("topic assignments must cover the complete approved Snack set");
  const expected = new Map(approvedRows.map((row) => [String(row.candidate_id), String(row.current_revision_id)]));
  for (const assignment of input.result.assignments) {
    if (expected.get(assignment.candidateId) !== assignment.revisionId) throw new Error("topic assignment does not match the approved Snack revision");
  }

  const now = Date.now();
  database.transaction(() => {
    database.query("UPDATE pipeline_requests SET status = 'applying-result', updated_at = ?1 WHERE id = ?2").run(now, request.id);
    for (const assignment of input.result.assignments) {
      const topic = resolveCanonicalTopic(assignment.primaryTopic)!;
      database.query(`INSERT INTO publication_snack_metadata(
        snack_revision_id, candidate_id, episode_id, primary_topic, rationale,
        pipeline_request_id, pipeline_run_id, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
      ON CONFLICT(snack_revision_id) DO UPDATE SET
        primary_topic = excluded.primary_topic, rationale = excluded.rationale,
        pipeline_request_id = excluded.pipeline_request_id, pipeline_run_id = excluded.pipeline_run_id,
        updated_at = excluded.updated_at`)
        .run(assignment.revisionId, assignment.candidateId, request.episodeId, topic.id,
          assignment.rationale, request.id, run.id, now);
      database.query("UPDATE thumbnail_jobs SET topic_colour = ?1, updated_at = ?2 WHERE snack_revision_id = ?3")
        .run(topic.colour, now, assignment.revisionId);
    }
    database.query(`INSERT INTO pipeline_artifacts(
      id, request_id, run_id, artifact_type, schema_version, content_json, created_at
    ) VALUES (?1, ?2, ?3, 'publication-topics', ?4, ?5, ?6)`)
      .run(crypto.randomUUID(), request.id, run.id, request.resultSchemaVersion, JSON.stringify({ assignments: input.result.assignments }), now);
    database.query(`UPDATE pipeline_runs SET
      status = 'complete', autopilot_run_id = COALESCE(autopilot_run_id, ?1),
      failure_category = NULL, failure_summary = NULL, progress_percent = 100,
      progress_label = 'Topics ready', completed_at = ?2, updated_at = ?2
      WHERE id = ?3`).run(input.result.runId, now, run.id);
    database.query(`UPDATE pipeline_requests SET
      status = 'completed', pipeline_version = COALESCE(?1, pipeline_version),
      result_applied_at = ?2, failure_summary = NULL, updated_at = ?2
      WHERE id = ?3`).run(input.result.pipelineVersion, now, request.id);
  })();
  return { replay: false, assignmentCount: input.result.assignments.length };
}
