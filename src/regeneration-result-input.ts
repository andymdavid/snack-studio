import type { PipelineCandidateResult, PipelineEvidence } from "./pipeline-result-input.ts";

export type SuccessfulRegenerationResult = {
  requestId: string;
  attemptId: string;
  runId: string | null;
  status: "ok";
  operation: "snack-regeneration";
  episodeId: string;
  candidateId: string;
  baseRevisionId: string;
  inputRevisionId: string;
  resultSchemaVersion: "1";
  promptSuiteVersion: string;
  pipelineVersion: string | null;
  evidence: PipelineEvidence[];
  candidate: PipelineCandidateResult;
  rationale: string | null;
};

const prohibitedPhrases = [
  "the key insight is", "this highlights", "this suggests", "this represents a fundamental shift",
  "this has profound implications", "this signals a broader transformation", "this changes the landscape",
];

function required(value: unknown, field: string, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max) throw new Error(`${field} is required and must be ${max} characters or fewer`);
  return text;
}

function optional(value: unknown, field: string, max: number): string | null {
  return value == null || value === "" ? null : required(value, field, max);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function publishable(value: string, field: string) {
  if (/[—:;]/.test(value)) throw new Error(`${field} contains prohibited punctuation`);
  const phrase = prohibitedPhrases.find((item) => value.toLowerCase().includes(item));
  if (phrase) throw new Error(`${field} contains prohibited phrase: ${phrase}`);
}

export function validateSuccessfulRegenerationResult(body: Record<string, unknown>):
  | { ok: true; value: SuccessfulRegenerationResult }
  | { ok: false; error: string } {
  try {
    if (body.status !== "ok") throw new Error("status must be ok");
    if (body.operation !== "snack-regeneration") throw new Error("operation must be snack-regeneration");
    if (body.resultSchemaVersion !== "1") throw new Error("unsupported resultSchemaVersion");
    const requestId = required(body.requestId, "requestId", 100);
    const attemptId = required(body.attemptId, "attemptId", 100);
    const runId = optional(body.runId, "runId", 200);
    const episodeId = required(body.episodeId, "episodeId", 100);
    const candidateId = required(body.candidateId, "candidateId", 100);
    const baseRevisionId = required(body.baseRevisionId, "baseRevisionId", 100);
    const inputRevisionId = required(body.inputRevisionId, "inputRevisionId", 100);
    const promptSuiteVersion = required(body.promptSuiteVersion, "promptSuiteVersion", 100);
    const pipelineVersion = optional(body.pipelineVersion, "pipelineVersion", 100);
    if (!Array.isArray(body.evidence) || !body.evidence.length) throw new Error("evidence is required");
    const evidence = body.evidence.map((raw, index) => {
      const item = object(raw, `evidence[${index}]`);
      return { evidenceId: required(item.evidenceId, `evidence[${index}].evidenceId`, 100), start: optional(item.start, "start", 30), end: optional(item.end, "end", 30), excerpt: required(item.excerpt, `evidence[${index}].excerpt`, 4000) };
    });
    const evidenceIds = new Set(evidence.map((item) => item.evidenceId));
    if (evidenceIds.size !== evidence.length) throw new Error("evidence IDs must be unique");
    const rawCandidate = object(body.candidate, "candidate");
    const editorialTitle = required(rawCandidate.editorialTitle, "candidate.editorialTitle", 200);
    const publicTitle = required(rawCandidate.publicTitle, "candidate.publicTitle", 200);
    const standfirst = required(rawCandidate.standfirst, "candidate.standfirst", 500);
    if (!Array.isArray(rawCandidate.paragraphs)) throw new Error("candidate.paragraphs must be an array");
    const paragraphs = rawCandidate.paragraphs.map((paragraph, index) => required(paragraph, `candidate.paragraphs[${index}]`, 5000));
    if (![3, 4].includes(paragraphs.length)) throw new Error("candidate must contain three or four paragraphs");
    const structureException = optional(rawCandidate.structureException, "candidate.structureException", 500);
    if (paragraphs.length === 4 && !structureException) throw new Error("four paragraphs requires structureException");
    if (paragraphs.length === 3 && structureException) throw new Error("three paragraphs must not declare structureException");
    if (paragraphs.join(" ").split(/\s+/).filter(Boolean).length > 275) throw new Error("candidate exceeds 275 words");
    [editorialTitle, publicTitle, standfirst, ...paragraphs].forEach((value, index) => publishable(value, `candidate prose ${index + 1}`));
    if (!Array.isArray(rawCandidate.claimEvidenceMap) || !rawCandidate.claimEvidenceMap.length) throw new Error("candidate.claimEvidenceMap is required");
    const claimEvidenceMap = rawCandidate.claimEvidenceMap.map((raw, index) => {
      const item = object(raw, `candidate.claimEvidenceMap[${index}]`);
      if (!Array.isArray(item.evidenceIds) || !item.evidenceIds.length) throw new Error(`candidate.claimEvidenceMap[${index}].evidenceIds is required`);
      const mappedIds = [...new Set(item.evidenceIds.map(String))];
      const unknown = mappedIds.find((id) => !evidenceIds.has(id));
      if (unknown) throw new Error(`candidate references unknown evidence ID ${unknown}`);
      return { claim: required(item.claim, `candidate.claimEvidenceMap[${index}].claim`, 1000), evidenceIds: mappedIds };
    });
    const validationWarnings = Array.isArray(rawCandidate.validationWarnings) ? rawCandidate.validationWarnings.map(String).filter(Boolean) : [];
    if (paragraphs.length === 4) validationWarnings.push(`Four-paragraph structure: ${structureException}`);
    const selectionId = required(rawCandidate.selectionId || candidateId, "candidate.selectionId", 100);
    return { ok: true, value: {
      requestId, attemptId, runId, status: "ok", operation: "snack-regeneration", episodeId, candidateId,
      baseRevisionId, inputRevisionId, resultSchemaVersion: "1", promptSuiteVersion, pipelineVersion,
      evidence, candidate: { selectionId, editorialTitle, publicTitle, standfirst, paragraphs, structureException, claimEvidenceMap, validationWarnings },
      rationale: optional(body.rationale, "rationale", 1000),
    } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
