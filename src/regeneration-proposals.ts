import { db } from "./db.ts";
import { getCandidate, type SnackCandidate } from "./candidates.ts";
import { recordAuditEvent } from "./episodes.ts";
import { getPipelineRequest, getPipelineRun } from "./pipeline-requests.ts";
import { transcriptContainsExactEvidence, type SuccessfulRegenerationResult } from "./regeneration-result-input.ts";

export type RegenerationProposal = {
  id: string;
  candidateId: string;
  baseRevisionId: string;
  pipelineRequestId: string;
  status: "proposed" | "adopted" | "discarded";
  instruction: string | null;
  editorialTitle: string;
  publicTitle: string;
  standfirst: string;
  bodyMarkdown: string;
  structureException: string | null;
  claimEvidenceMap: Array<{ claim: string; evidenceIds: string[] }>;
  transcriptExcerpt: string | null;
  rationale: string | null;
  validationWarnings: string[];
  createdAt: number;
  resolvedAt: number | null;
};

function jsonArray<T>(value: unknown): T[] {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function mapProposal(row: Record<string, unknown>): RegenerationProposal {
  return {
    id: String(row.id),
    candidateId: String(row.candidate_id),
    baseRevisionId: String(row.base_revision_id),
    pipelineRequestId: String(row.pipeline_request_id),
    status: String(row.status) as RegenerationProposal["status"],
    instruction: row.instruction == null ? null : String(row.instruction),
    editorialTitle: String(row.editorial_title),
    publicTitle: String(row.public_title),
    standfirst: String(row.standfirst),
    bodyMarkdown: String(row.body_markdown),
    structureException: row.structure_exception == null ? null : String(row.structure_exception),
    claimEvidenceMap: jsonArray(row.claim_evidence_json),
    transcriptExcerpt: row.transcript_excerpt == null ? null : String(row.transcript_excerpt),
    rationale: row.rationale == null ? null : String(row.rationale),
    validationWarnings: jsonArray(row.validation_warnings_json).map(String),
    createdAt: Number(row.created_at),
    resolvedAt: row.resolved_at == null ? null : Number(row.resolved_at),
  };
}

export function listRegenerationProposals(candidateId: string): RegenerationProposal[] {
  const rows = db.query("SELECT * FROM snack_regeneration_proposals WHERE candidate_id = ?1 ORDER BY created_at DESC")
    .all(candidateId) as Record<string, unknown>[];
  return rows.map(mapProposal);
}

export function createRegenerationProposal(input: {
  candidateId: string;
  baseRevisionId: string;
  pipelineRequestId: string;
  instruction: string | null;
  editorialTitle: string;
  publicTitle: string;
  standfirst: string;
  paragraphs: string[];
  structureException: string | null;
  claimEvidenceMap: Array<{ claim: string; evidenceIds: string[] }>;
  transcriptExcerpt: string | null;
  rationale: string | null;
  validationWarnings: string[];
}): RegenerationProposal {
  const candidate = getCandidate(input.candidateId);
  if (!candidate) throw new Error("regeneration candidate not found");
  if (!candidate.revisions.some((revision) => revision.id === input.baseRevisionId)) throw new Error("regeneration base revision not found");
  const existing = db.query("SELECT * FROM snack_regeneration_proposals WHERE pipeline_request_id = ?1").get(input.pipelineRequestId) as Record<string, unknown> | null;
  if (existing) return mapProposal(existing);
  const id = crypto.randomUUID();
  const now = Date.now();
  db.query(`INSERT INTO snack_regeneration_proposals(
    id, candidate_id, base_revision_id, pipeline_request_id, instruction, editorial_title,
    public_title, standfirst, body_markdown, structure_exception, claim_evidence_json,
    transcript_excerpt, rationale, validation_warnings_json, created_at
  ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`)
    .run(id, input.candidateId, input.baseRevisionId, input.pipelineRequestId, input.instruction,
      input.editorialTitle, input.publicTitle, input.standfirst, input.paragraphs.join("\n\n"),
      input.structureException, JSON.stringify(input.claimEvidenceMap), input.transcriptExcerpt,
      input.rationale, JSON.stringify(input.validationWarnings), now);
  return listRegenerationProposals(input.candidateId).find((proposal) => proposal.id === id)!;
}

export function applySuccessfulRegenerationResult(input: { localRunId: string; result: SuccessfulRegenerationResult }): RegenerationProposal {
  const request = getPipelineRequest(input.result.requestId);
  const run = getPipelineRun(input.localRunId);
  if (!request || !run || run.requestId !== request.id) throw new Error("regeneration callback target not found");
  if (request.operation !== "snack-regeneration") throw new Error("regeneration callback operation mismatch");
  if (request.episodeId !== input.result.episodeId || request.targetCandidateId !== input.result.candidateId) throw new Error("regeneration callback candidate mismatch");
  if (request.baseCandidateRevisionId !== input.result.baseRevisionId) throw new Error("regeneration callback base revision mismatch");
  if (request.inputTranscriptRevisionId !== input.result.inputRevisionId) throw new Error("regeneration callback transcript mismatch");
  if (request.promptSuiteVersion !== input.result.promptSuiteVersion || request.resultSchemaVersion !== input.result.resultSchemaVersion) throw new Error("regeneration callback version mismatch");
  if (run.autopilotRunId && input.result.runId && run.autopilotRunId !== input.result.runId) throw new Error("regeneration callback Autopilot run mismatch");
  const transcript = db.query("SELECT transcript_text FROM transcript_revisions WHERE id = ?1").get(request.inputTranscriptRevisionId) as { transcript_text: string } | null;
  if (!transcript) throw new Error("regeneration source transcript not found");
  for (const evidence of input.result.evidence) {
    if (!transcriptContainsExactEvidence(transcript.transcript_text, evidence.excerpt)) throw new Error(`regeneration evidence ${evidence.evidenceId} is not an exact transcript excerpt`);
  }
  const usedIds = new Set(input.result.candidate.claimEvidenceMap.flatMap((mapping) => mapping.evidenceIds));
  const transcriptExcerpt = input.result.evidence.filter((evidence) => usedIds.has(evidence.evidenceId)).map((evidence) => evidence.excerpt).join("\n\n");
  const now = Date.now();
  let proposal!: RegenerationProposal;
  db.transaction(() => {
    db.query(`INSERT INTO pipeline_artifacts(id, request_id, run_id, artifact_type, schema_version, content_json, created_at)
      VALUES (?1, ?2, ?3, 'evidence', ?4, ?5, ?6)`)
      .run(crypto.randomUUID(), request.id, run.id, input.result.resultSchemaVersion, JSON.stringify({ evidence: input.result.evidence }), now);
    db.query(`INSERT INTO pipeline_artifacts(id, request_id, run_id, artifact_type, schema_version, content_json, created_at)
      VALUES (?1, ?2, ?3, 'regeneration-proposal', ?4, ?5, ?6)`)
      .run(crypto.randomUUID(), request.id, run.id, input.result.resultSchemaVersion, JSON.stringify({ candidate: input.result.candidate, rationale: input.result.rationale }), now);
    proposal = createRegenerationProposal({
      candidateId: input.result.candidateId, baseRevisionId: input.result.baseRevisionId,
      pipelineRequestId: request.id, instruction: request.regenerationInstruction,
      editorialTitle: input.result.candidate.editorialTitle, publicTitle: input.result.candidate.publicTitle,
      standfirst: input.result.candidate.standfirst, paragraphs: input.result.candidate.paragraphs,
      structureException: input.result.candidate.structureException, claimEvidenceMap: input.result.candidate.claimEvidenceMap,
      transcriptExcerpt, rationale: input.result.rationale, validationWarnings: input.result.candidate.validationWarnings,
    });
    db.query("UPDATE pipeline_runs SET status = 'complete', autopilot_run_id = COALESCE(autopilot_run_id, ?1), progress_percent = 100, progress_label = 'Alternative ready', completed_at = ?2, updated_at = ?2 WHERE id = ?3")
      .run(input.result.runId, now, run.id);
    db.query("UPDATE pipeline_requests SET status = 'completed', pipeline_version = COALESCE(?1, pipeline_version), result_applied_at = ?2, failure_summary = NULL, updated_at = ?2 WHERE id = ?3")
      .run(input.result.pipelineVersion, now, request.id);
  })();
  return proposal;
}

export function resolveRegenerationProposal(id: string, resolution: "adopted" | "discarded", actorPubkey: string): SnackCandidate | null {
  const row = db.query("SELECT * FROM snack_regeneration_proposals WHERE id = ?1").get(id) as Record<string, unknown> | null;
  if (!row) return null;
  const proposal = mapProposal(row);
  const candidate = getCandidate(proposal.candidateId);
  if (!candidate) return null;
  if (proposal.status !== "proposed") throw new Error("regeneration proposal is already resolved");
  if (resolution === "adopted" && candidate.currentRevisionId !== proposal.baseRevisionId) {
    throw new Error("The Snack changed after this alternative was requested; discard it or generate a new alternative");
  }
  const now = Date.now();
  db.transaction(() => {
    if (resolution === "adopted") {
      const revisionId = crypto.randomUUID();
      const revisionNumber = candidate.revisionCount + 1;
      if (candidate.approvedPosition !== null) {
        db.query("UPDATE snack_candidates SET approved_position = NULL WHERE id = ?1").run(candidate.id);
        db.query("UPDATE snack_candidates SET approved_position = approved_position - 1 WHERE episode_id = ?1 AND approved_position > ?2")
          .run(candidate.episodeId, candidate.approvedPosition);
      }
      db.query(`INSERT INTO snack_revisions(
        id, candidate_id, revision_number, public_title, editorial_title, standfirst, body_markdown,
        related_topics_json, transcript_excerpt, public_state, origin, change_note, created_by_pubkey,
        created_at, pipeline_request_id, source_transcript_revision_id, prompt_suite_version,
        pipeline_version, result_schema_version, structure_exception, claim_evidence_json,
        validation_warnings_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '[]', ?8, 'draft', 'pipeline', ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`)
        .run(revisionId, candidate.id, revisionNumber, proposal.publicTitle, proposal.editorialTitle,
          proposal.standfirst, proposal.bodyMarkdown, proposal.transcriptExcerpt,
          `Adopted regeneration proposal ${proposal.id}`, actorPubkey, now, proposal.pipelineRequestId,
          candidate.revision.sourceTranscriptRevisionId, candidate.revision.promptSuiteVersion,
          candidate.revision.pipelineVersion, candidate.revision.resultSchemaVersion,
          proposal.structureException, JSON.stringify(proposal.claimEvidenceMap), JSON.stringify(proposal.validationWarnings));
      db.query("UPDATE snack_candidates SET current_revision_id = ?1, review_decision = 'in-review', updated_at = ?2 WHERE id = ?3")
        .run(revisionId, now, candidate.id);
      db.query("UPDATE episodes SET status = 'in-review', updated_at = ?1 WHERE id = ?2").run(now, candidate.episodeId);
    }
    db.query("UPDATE snack_regeneration_proposals SET status = ?1, resolved_at = ?2 WHERE id = ?3").run(resolution, now, id);
    recordAuditEvent({ actorPubkey, action: `candidate.regeneration.${resolution}`, entityType: "episode", entityId: candidate.episodeId, detail: { candidateId: candidate.id, proposalId: id } });
  })();
  return getCandidate(candidate.id);
}
