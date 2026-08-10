import { db } from "./db.ts";
import { getEpisode, recordAuditEvent } from "./episodes.ts";

export const REVIEW_DECISIONS = ["generated", "in-review", "accepted", "rejected", "regeneration-requested"] as const;
export type ReviewDecision = typeof REVIEW_DECISIONS[number];

export type SnackRevision = {
  id: string;
  candidateId: string;
  revisionNumber: number;
  publicTitle: string;
  editorialTitle: string | null;
  standfirst: string;
  bodyMarkdown: string;
  attribution: string | null;
  primaryTopic: string | null;
  relatedTopics: string[];
  transcriptTimestamp: string | null;
  transcriptExcerpt: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  publicState: "draft" | "review" | "published";
  origin: "fixture" | "pipeline" | "editor";
  changeNote: string | null;
  createdByPubkey: string | null;
  createdAt: number;
  pipelineRequestId: string | null;
  pipelineRunId: string | null;
  sourceTranscriptRevisionId: string | null;
  promptSuiteVersion: string | null;
  pipelineVersion: string | null;
  resultSchemaVersion: string | null;
  structureException: string | null;
  claimEvidenceMap: Array<{ claim: string; evidenceIds: string[] }>;
  validationWarnings: string[];
};

export type SnackCandidate = {
  id: string;
  episodeId: string;
  reviewDecision: ReviewDecision;
  currentRevisionId: string;
  createdAt: number;
  updatedAt: number;
  revision: SnackRevision;
  revisionCount: number;
  revisions: SnackRevision[];
  pipelineRequestId: string | null;
  selectionId: string | null;
};

function stringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function claimEvidenceArray(value: unknown): Array<{ claim: string; evidenceIds: string[] }> {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item === "object" && !Array.isArray(item)).map((item) => ({
      claim: String((item as Record<string, unknown>).claim || ""),
      evidenceIds: Array.isArray((item as Record<string, unknown>).evidenceIds)
        ? ((item as Record<string, unknown>).evidenceIds as unknown[]).map(String)
        : [],
    }));
  } catch {
    return [];
  }
}

function mapRevision(row: Record<string, unknown>): SnackRevision {
  return {
    id: String(row.revision_id ?? row.id),
    candidateId: String(row.candidate_id),
    revisionNumber: Number(row.revision_number),
    publicTitle: String(row.public_title),
    editorialTitle: row.editorial_title == null ? null : String(row.editorial_title),
    standfirst: String(row.standfirst),
    bodyMarkdown: String(row.body_markdown),
    attribution: row.attribution == null ? null : String(row.attribution),
    primaryTopic: row.primary_topic == null ? null : String(row.primary_topic),
    relatedTopics: stringArray(row.related_topics_json),
    transcriptTimestamp: row.transcript_timestamp == null ? null : String(row.transcript_timestamp),
    transcriptExcerpt: row.transcript_excerpt == null ? null : String(row.transcript_excerpt),
    seoTitle: row.seo_title == null ? null : String(row.seo_title),
    seoDescription: row.seo_description == null ? null : String(row.seo_description),
    publicState: String(row.public_state) as SnackRevision["publicState"],
    origin: String(row.origin) as SnackRevision["origin"],
    changeNote: row.change_note == null ? null : String(row.change_note),
    createdByPubkey: row.created_by_pubkey == null ? null : String(row.created_by_pubkey),
    createdAt: Number(row.revision_created_at ?? row.created_at),
    pipelineRequestId: row.pipeline_request_id == null ? null : String(row.pipeline_request_id),
    pipelineRunId: row.pipeline_run_id == null ? null : String(row.pipeline_run_id),
    sourceTranscriptRevisionId: row.source_transcript_revision_id == null ? null : String(row.source_transcript_revision_id),
    promptSuiteVersion: row.prompt_suite_version == null ? null : String(row.prompt_suite_version),
    pipelineVersion: row.pipeline_version == null ? null : String(row.pipeline_version),
    resultSchemaVersion: row.result_schema_version == null ? null : String(row.result_schema_version),
    structureException: row.structure_exception == null ? null : String(row.structure_exception),
    claimEvidenceMap: claimEvidenceArray(row.claim_evidence_json),
    validationWarnings: stringArray(row.validation_warnings_json),
  };
}

function mapCandidate(row: Record<string, unknown>): SnackCandidate {
  return {
    id: String(row.id),
    episodeId: String(row.episode_id),
    reviewDecision: String(row.review_decision) as ReviewDecision,
    currentRevisionId: String(row.current_revision_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    revision: mapRevision(row),
    revisionCount: Number(row.revision_count || 1),
    revisions: [],
    pipelineRequestId: row.pipeline_request_id == null ? null : String(row.pipeline_request_id),
    selectionId: row.selection_id == null ? null : String(row.selection_id),
  };
}

const candidateSelect = `
  SELECT c.*, r.id AS revision_id, r.revision_number, r.public_title, r.editorial_title,
    r.standfirst, r.body_markdown, r.attribution, r.primary_topic, r.related_topics_json,
    r.transcript_timestamp, r.transcript_excerpt, r.seo_title, r.seo_description,
    r.public_state, r.origin, r.change_note, r.created_by_pubkey,
    r.pipeline_run_id, r.source_transcript_revision_id, r.prompt_suite_version,
    r.pipeline_version, r.result_schema_version, r.structure_exception,
    r.claim_evidence_json, r.validation_warnings_json,
    r.created_at AS revision_created_at,
    (SELECT COUNT(*) FROM snack_revisions all_revisions WHERE all_revisions.candidate_id = c.id) AS revision_count
  FROM snack_candidates c
  JOIN snack_revisions r ON r.id = c.current_revision_id
`;

export function listCandidates(episodeId: string): SnackCandidate[] {
  const rows = db.query(`${candidateSelect} WHERE c.episode_id = ?1 ORDER BY c.created_at ASC`).all(episodeId) as Record<string, unknown>[];
  return rows.map(mapCandidate).map((candidate) => ({ ...candidate, revisions: listCandidateRevisions(candidate.id) }));
}

export function getCandidate(id: string): SnackCandidate | null {
  const row = db.query(`${candidateSelect} WHERE c.id = ?1`).get(id) as Record<string, unknown> | null;
  if (!row) return null;
  const candidate = mapCandidate(row);
  candidate.revisions = listCandidateRevisions(candidate.id);
  return candidate;
}

export function listCandidateRevisions(candidateId: string): SnackRevision[] {
  const rows = db.query(`SELECT id AS revision_id, * FROM snack_revisions WHERE candidate_id = ?1 ORDER BY revision_number DESC`)
    .all(candidateId) as Record<string, unknown>[];
  return rows.map(mapRevision);
}

const fixtureIdeas = [
  ["Operational Knowledge Becomes Software When Experts Can Express It", "The people closest to a workflow can turn their judgement into useful software when tools reduce the translation gap."],
  ["Fast Production Makes Architectural Judgement More Valuable", "Greater implementation speed increases the importance of choosing sound boundaries before complexity compounds."],
  ["Reliable Feedback Is What Makes Long Agent Runs Possible", "Long-running automated work depends less on raw duration than on trustworthy checks and corrective signals."],
  ["Real Use Reveals Requirements That Planning Cannot", "Repeated practical use exposes missing requirements that are difficult to discover in abstract planning."],
  ["Tools Shape the Kind of Thinking Their Users Can Do", "A tool is not merely an output mechanism; its constraints influence how people frame and solve problems."],
  ["Specific Context Produces More Useful Automated Work", "Automation improves when it receives precise operational context instead of broad instructions and inferred assumptions."],
  ["Review Is a Product Capability, Not a Final Check", "Human review works best when evidence, alternatives, and decisions are represented directly in the workflow."],
  ["Stable Boundaries Let Systems Change Safely", "Clear ownership between applications reduces accidental coupling and makes later changes easier to reason about."],
  ["Revision History Protects Editorial Judgement", "Preserving prior versions allows editors to experiment without turning every change into an irreversible decision."],
  ["Publishing and Deployment Are Different Decisions", "Separating content publication from production deployment creates a clearer audit trail and safer recovery path."],
] as const;

export function generateFixtureCandidates(episodeId: string, actorPubkey: string): SnackCandidate[] {
  const episode = getEpisode(episodeId);
  if (!episode) throw new Error("episode not found");
  if (listCandidates(episodeId).length) throw new Error("candidate set already exists");
  const now = Date.now();
  db.transaction(() => {
    fixtureIdeas.forEach(([title, standfirst], index) => {
      const candidateId = crypto.randomUUID();
      const revisionId = crypto.randomUUID();
      const createdAt = now + index;
      db.query(`INSERT INTO snack_candidates(id, episode_id, review_decision, current_revision_id, created_at, updated_at)
        VALUES (?1, ?2, 'generated', ?3, ?4, ?4)`)
        .run(candidateId, episodeId, revisionId, createdAt);
      db.query(`INSERT INTO snack_revisions(
        id, candidate_id, revision_number, public_title, standfirst, body_markdown,
        attribution, primary_topic, related_topics_json, transcript_excerpt,
        public_state, origin, change_note, created_by_pubkey, created_at
      ) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, 'Technology', '[]', ?7, 'draft', 'fixture', 'Initial fixture candidate', ?8, ?9)`)
        .run(
          revisionId,
          candidateId,
          title,
          standfirst,
          `## Working draft\n\n${standfirst}\n\nThis fixture exists to exercise Snack Studio's editorial review workflow before pipeline integration.`,
          "Conversation participants",
          `Fixture provenance for ${episode.workingTitle}; replace with transcript-supported evidence during review.`,
          actorPubkey,
          createdAt,
        );
    });
    db.query("UPDATE episodes SET status = 'in-review', updated_at = ?1 WHERE id = ?2").run(now, episodeId);
    recordAuditEvent({ actorPubkey, action: "candidates.fixture.generated", entityType: "episode", entityId: episodeId, detail: { count: fixtureIdeas.length } });
  })();
  return listCandidates(episodeId);
}

export function updateCandidateDecision(id: string, decision: ReviewDecision, actorPubkey: string): SnackCandidate | null {
  const candidate = getCandidate(id);
  if (!candidate) return null;
  const now = Date.now();
  db.transaction(() => {
    db.query("UPDATE snack_candidates SET review_decision = ?1, updated_at = ?2 WHERE id = ?3").run(decision, now, id);
    db.query("UPDATE episodes SET updated_at = ?1 WHERE id = ?2").run(now, candidate.episodeId);
    recordAuditEvent({ actorPubkey, action: "candidate.decision.updated", entityType: "episode", entityId: candidate.episodeId, detail: { candidateId: id, decision } });
  })();
  return getCandidate(id);
}

export type CandidateRevisionInput = {
  publicTitle: string;
  editorialTitle: string | null;
  standfirst: string;
  bodyMarkdown: string;
  attribution: string | null;
  primaryTopic: string | null;
  relatedTopics: string[];
  transcriptTimestamp: string | null;
  transcriptExcerpt: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  changeNote: string | null;
};

export function createCandidateRevision(id: string, input: CandidateRevisionInput, actorPubkey: string): SnackCandidate | null {
  const candidate = getCandidate(id);
  if (!candidate) return null;
  const now = Date.now();
  const revisionId = crypto.randomUUID();
  const revisionNumber = candidate.revisionCount + 1;
  db.transaction(() => {
    db.query(`INSERT INTO snack_revisions(
      id, candidate_id, revision_number, public_title, editorial_title, standfirst,
      body_markdown, attribution, primary_topic, related_topics_json,
      transcript_timestamp, transcript_excerpt, seo_title, seo_description,
      public_state, origin, change_note, created_by_pubkey, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'draft', 'editor', ?15, ?16, ?17)`)
      .run(revisionId, id, revisionNumber, input.publicTitle, input.editorialTitle, input.standfirst, input.bodyMarkdown,
        input.attribution, input.primaryTopic, JSON.stringify(input.relatedTopics), input.transcriptTimestamp, input.transcriptExcerpt, input.seoTitle,
        input.seoDescription, input.changeNote, actorPubkey, now);
    db.query("UPDATE snack_candidates SET current_revision_id = ?1, review_decision = 'in-review', updated_at = ?2 WHERE id = ?3")
      .run(revisionId, now, id);
    db.query("UPDATE episodes SET updated_at = ?1 WHERE id = ?2").run(now, candidate.episodeId);
    recordAuditEvent({ actorPubkey, action: "candidate.revision.created", entityType: "episode", entityId: candidate.episodeId, detail: { candidateId: id, revisionId, revisionNumber } });
  })();
  return getCandidate(id);
}

export function activateCandidateRevision(candidateId: string, revisionId: string, actorPubkey: string): SnackCandidate | null {
  const candidate = getCandidate(candidateId);
  if (!candidate || !candidate.revisions.some((revision) => revision.id === revisionId)) return null;
  const revision = candidate.revisions.find((item) => item.id === revisionId)!;
  const now = Date.now();
  db.transaction(() => {
    db.query("UPDATE snack_candidates SET current_revision_id = ?1, review_decision = 'in-review', updated_at = ?2 WHERE id = ?3")
      .run(revisionId, now, candidateId);
    db.query("UPDATE episodes SET updated_at = ?1 WHERE id = ?2").run(now, candidate.episodeId);
    recordAuditEvent({ actorPubkey, action: "candidate.revision.activated", entityType: "episode", entityId: candidate.episodeId, detail: { candidateId, revisionId, revisionNumber: revision.revisionNumber } });
  })();
  return getCandidate(candidateId);
}
