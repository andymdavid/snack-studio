import { db } from "./db.ts";
import { getCandidate, type SnackCandidate } from "./candidates.ts";
import { recordAuditEvent } from "./episodes.ts";

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

export function resolveRegenerationProposal(id: string, resolution: "adopted" | "discarded", actorPubkey: string): SnackCandidate | null {
  const row = db.query("SELECT * FROM snack_regeneration_proposals WHERE id = ?1").get(id) as Record<string, unknown> | null;
  if (!row) return null;
  const proposal = mapProposal(row);
  const candidate = getCandidate(proposal.candidateId);
  if (!candidate) return null;
  if (proposal.status !== "proposed") throw new Error("regeneration proposal is already resolved");
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
