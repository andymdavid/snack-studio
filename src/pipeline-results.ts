import type { Database } from "bun:sqlite";
import { db as appDb } from "./db.ts";
import type { SuccessfulPipelineResult } from "./pipeline-result-input.ts";
import { getPipelineRequest, getPipelineRun } from "./pipeline-requests.ts";

export function applySuccessfulPipelineResult(input: {
  localRunId: string;
  result: SuccessfulPipelineResult;
}, database: Database = appDb): { replay: boolean; candidateCount: number } {
  const request = getPipelineRequest(input.result.requestId, database);
  const run = getPipelineRun(input.localRunId, database);
  if (!request || !run || run.requestId !== request.id) throw new Error("pipeline callback target not found");
  if (request.status === "completed" && request.resultAppliedAt) {
    const count = database.query("SELECT COUNT(*) AS count FROM snack_candidates WHERE pipeline_request_id = ?1").get(request.id) as { count: number };
    return { replay: true, candidateCount: Number(count.count) };
  }
  if (request.operation !== input.result.operation) throw new Error("pipeline callback operation mismatch");
  if (request.episodeId !== input.result.episodeId) throw new Error("pipeline callback episode mismatch");
  if (request.inputTranscriptRevisionId !== input.result.inputRevisionId) throw new Error("pipeline callback transcript revision mismatch");
  if (request.resultSchemaVersion !== input.result.resultSchemaVersion) throw new Error("pipeline callback result schema mismatch");
  if (request.promptSuiteVersion !== input.result.promptSuiteVersion) throw new Error("pipeline callback prompt suite mismatch");
  if (run.autopilotRunId && input.result.runId && run.autopilotRunId !== input.result.runId) throw new Error("pipeline callback Autopilot run mismatch");

  const now = Date.now();
  database.transaction(() => {
    const current = getPipelineRequest(request.id, database);
    if (current?.status === "completed" && current.resultAppliedAt) return;
    database.query("UPDATE pipeline_requests SET status = 'applying-result', updated_at = ?1 WHERE id = ?2").run(now, request.id);

    const artifacts = [
      { artifactType: "evidence", schemaVersion: input.result.resultSchemaVersion, content: { evidence: input.result.evidence } },
      { artifactType: "validated-result", schemaVersion: input.result.resultSchemaVersion, content: {
        declaredShortfall: input.result.declaredShortfall,
        candidates: input.result.candidates,
      } },
      ...input.result.artifacts,
    ];
    for (const artifact of artifacts) {
      database.query(`
        INSERT INTO pipeline_artifacts(id, request_id, run_id, artifact_type, schema_version, content_json, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      `).run(crypto.randomUUID(), request.id, run.id, artifact.artifactType, artifact.schemaVersion, JSON.stringify(artifact.content), now);
    }

    input.result.candidates.forEach((candidate, index) => {
      const candidateId = crypto.randomUUID();
      const revisionId = crypto.randomUUID();
      const createdAt = now + index;
      const candidateEvidenceIds = new Set(candidate.claimEvidenceMap.flatMap((mapping) => mapping.evidenceIds));
      const candidateEvidence = input.result.evidence.filter((evidence) => candidateEvidenceIds.has(evidence.evidenceId));
      const transcriptTimestamp = candidateEvidence.find((evidence) => evidence.start)?.start || null;
      const transcriptExcerpt = candidateEvidence.map((evidence) => [
        evidence.start ? `[${evidence.start}${evidence.end ? `–${evidence.end}` : ""}]` : null,
        evidence.excerpt,
      ].filter(Boolean).join(" ")).join("\n\n");
      database.query(`
        INSERT INTO snack_candidates(
          id, episode_id, review_decision, current_revision_id, pipeline_request_id, selection_id, created_at, updated_at
        ) VALUES (?1, ?2, 'generated', ?3, ?4, ?5, ?6, ?6)
      `).run(candidateId, request.episodeId, revisionId, request.id, candidate.selectionId, createdAt);
      database.query(`
        INSERT INTO snack_revisions(
          id, candidate_id, revision_number, public_title, editorial_title, standfirst, body_markdown,
          related_topics_json, transcript_timestamp, transcript_excerpt, public_state, origin, change_note, created_at,
          pipeline_request_id, pipeline_run_id, source_transcript_revision_id, prompt_suite_version,
          pipeline_version, result_schema_version, structure_exception, claim_evidence_json,
          validation_warnings_json
        ) VALUES (
          ?1, ?2, 1, ?3, ?4, ?5, ?6, '[]', ?7, ?8, 'draft', 'pipeline', 'Initial Autopilot candidate', ?9,
          ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18
        )
      `).run(
        revisionId,
        candidateId,
        candidate.publicTitle,
        candidate.editorialTitle,
        candidate.standfirst,
        candidate.paragraphs.join("\n\n"),
        transcriptTimestamp,
        transcriptExcerpt,
        createdAt,
        request.id,
        run.id,
        request.inputTranscriptRevisionId,
        input.result.promptSuiteVersion,
        input.result.pipelineVersion,
        input.result.resultSchemaVersion,
        candidate.structureException,
        JSON.stringify(candidate.claimEvidenceMap),
        JSON.stringify(candidate.validationWarnings),
      );
    });

    database.query(`
      UPDATE pipeline_runs
      SET status = 'complete', autopilot_run_id = COALESCE(autopilot_run_id, ?1),
          failure_category = NULL, failure_summary = NULL, progress_percent = 100,
          progress_label = 'Snacks ready', completed_at = ?2, updated_at = ?2
      WHERE id = ?3
    `).run(input.result.runId, now, run.id);
    database.query(`
      UPDATE pipeline_requests
      SET status = 'completed', pipeline_version = COALESCE(?1, pipeline_version), result_applied_at = ?2,
          failure_summary = NULL, updated_at = ?2
      WHERE id = ?3
    `).run(input.result.pipelineVersion, now, request.id);
    database.query("UPDATE episodes SET status = 'in-review', updated_at = ?1 WHERE id = ?2").run(now, request.episodeId);
  })();

  return { replay: false, candidateCount: input.result.candidates.length };
}
