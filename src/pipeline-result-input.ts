export type PipelineEvidence = {
  evidenceId: string;
  start: string | null;
  end: string | null;
  excerpt: string;
};

export type PipelineCandidateResult = {
  selectionId: string;
  editorialTitle: string;
  publicTitle: string;
  standfirst: string;
  paragraphs: string[];
  structureException: string | null;
  claimEvidenceMap: Array<{ claim: string; evidenceIds: string[] }>;
  validationWarnings: string[];
};

export type SuccessfulPipelineResult = {
  requestId: string;
  attemptId: string;
  runId: string | null;
  status: "ok";
  operation: "transcript-to-snacks";
  episodeId: string;
  inputRevisionId: string;
  resultSchemaVersion: "1";
  promptSuiteVersion: string;
  pipelineVersion: string | null;
  declaredShortfall: { reason: string } | null;
  evidence: PipelineEvidence[];
  candidates: PipelineCandidateResult[];
  artifacts: Array<{ artifactType: string; schemaVersion: string; content: Record<string, unknown> }>;
};

const PROHIBITED_PHRASES = [
  "the key insight is",
  "this highlights",
  "this suggests",
  "this represents a fundamental shift",
  "this has profound implications",
  "this signals a broader transformation",
  "this changes the landscape",
];

function requiredString(value: unknown, field: string, max: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > max) throw new Error(`${field} is required and must be ${max} characters or fewer`);
  return normalized;
}

function optionalString(value: unknown, field: string, max: number): string | null {
  if (value == null || value === "") return null;
  return requiredString(value, field, max);
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function wordCount(paragraphs: string[]): number {
  return paragraphs.join(" ").trim().split(/\s+/).filter(Boolean).length;
}

function validatePublishableProse(value: string, field: string): void {
  if (/[—:;]/.test(value)) throw new Error(`${field} contains prohibited punctuation`);
  const lower = value.toLowerCase();
  const phrase = PROHIBITED_PHRASES.find((item) => lower.includes(item));
  if (phrase) throw new Error(`${field} contains prohibited phrase: ${phrase}`);
}

export function validateSuccessfulPipelineResult(body: Record<string, unknown>):
  | { ok: true; value: SuccessfulPipelineResult }
  | { ok: false; error: string } {
  try {
    const requestId = requiredString(body.requestId, "requestId", 100);
    const attemptId = requiredString(body.attemptId, "attemptId", 100);
    const runId = optionalString(body.runId, "runId", 200);
    if (body.status !== "ok") throw new Error("status must be ok");
    if (body.operation !== "transcript-to-snacks") throw new Error("operation must be transcript-to-snacks");
    const episodeId = requiredString(body.episodeId, "episodeId", 100);
    const inputRevisionId = requiredString(body.inputRevisionId, "inputRevisionId", 100);
    if (body.resultSchemaVersion !== "1") throw new Error("unsupported resultSchemaVersion");
    const promptSuiteVersion = requiredString(body.promptSuiteVersion, "promptSuiteVersion", 100);
    const pipelineVersion = optionalString(body.pipelineVersion, "pipelineVersion", 100);
    const shortfallObject = body.declaredShortfall == null ? null : objectValue(body.declaredShortfall, "declaredShortfall");
    const declaredShortfall = shortfallObject ? { reason: requiredString(shortfallObject.reason, "declaredShortfall.reason", 500) } : null;

    if (!Array.isArray(body.evidence)) throw new Error("evidence must be an array");
    const evidence = body.evidence.map((raw, index) => {
      const item = objectValue(raw, `evidence[${index}]`);
      return {
        evidenceId: requiredString(item.evidenceId, `evidence[${index}].evidenceId`, 100),
        start: optionalString(item.start, `evidence[${index}].start`, 30),
        end: optionalString(item.end, `evidence[${index}].end`, 30),
        excerpt: requiredString(item.excerpt, `evidence[${index}].excerpt`, 4000),
      };
    });
    const evidenceIds = new Set(evidence.map((item) => item.evidenceId));
    if (evidenceIds.size !== evidence.length) throw new Error("evidence IDs must be unique");

    if (!Array.isArray(body.candidates)) throw new Error("candidates must be an array");
    if (body.candidates.length > 7) throw new Error("candidate count must not exceed seven");
    if (body.candidates.length < 6 && !declaredShortfall) throw new Error("fewer than six candidates requires declaredShortfall");
    if (!body.candidates.length) throw new Error("at least one candidate is required");
    const candidates = body.candidates.map((raw, index) => {
      const item = objectValue(raw, `candidates[${index}]`);
      const selectionId = requiredString(item.selectionId, `candidates[${index}].selectionId`, 100);
      const editorialTitle = requiredString(item.editorialTitle, `candidates[${index}].editorialTitle`, 200);
      const publicTitle = requiredString(item.publicTitle, `candidates[${index}].publicTitle`, 200);
      const standfirst = requiredString(item.standfirst, `candidates[${index}].standfirst`, 500);
      if (!Array.isArray(item.paragraphs)) throw new Error(`candidates[${index}].paragraphs must be an array`);
      const paragraphs = item.paragraphs.map((paragraph, paragraphIndex) => requiredString(paragraph, `candidates[${index}].paragraphs[${paragraphIndex}]`, 5000));
      if (![3, 4].includes(paragraphs.length)) throw new Error(`candidates[${index}] must contain three or four paragraphs`);
      const structureException = optionalString(item.structureException, `candidates[${index}].structureException`, 500);
      if (paragraphs.length === 4 && !structureException) throw new Error(`candidates[${index}] requires structureException for four paragraphs`);
      if (paragraphs.length === 3 && structureException) throw new Error(`candidates[${index}] must not declare a structureException for three paragraphs`);
      if (wordCount(paragraphs) > 275) throw new Error(`candidates[${index}] exceeds 275 words`);
      validatePublishableProse(editorialTitle, `candidates[${index}].editorialTitle`);
      validatePublishableProse(publicTitle, `candidates[${index}].publicTitle`);
      validatePublishableProse(standfirst, `candidates[${index}].standfirst`);
      paragraphs.forEach((paragraph, paragraphIndex) => validatePublishableProse(paragraph, `candidates[${index}].paragraphs[${paragraphIndex}]`));
      if (!Array.isArray(item.claimEvidenceMap) || !item.claimEvidenceMap.length) throw new Error(`candidates[${index}].claimEvidenceMap is required`);
      const claimEvidenceMap = item.claimEvidenceMap.map((rawMap, mapIndex) => {
        const map = objectValue(rawMap, `candidates[${index}].claimEvidenceMap[${mapIndex}]`);
        if (!Array.isArray(map.evidenceIds) || !map.evidenceIds.length) throw new Error(`candidates[${index}].claimEvidenceMap[${mapIndex}].evidenceIds is required`);
        const mappedIds = [...new Set(map.evidenceIds.map(String))];
        const unknown = mappedIds.find((id) => !evidenceIds.has(id));
        if (unknown) throw new Error(`candidates[${index}] references unknown evidence ID ${unknown}`);
        return { claim: requiredString(map.claim, `candidates[${index}].claimEvidenceMap[${mapIndex}].claim`, 1000), evidenceIds: mappedIds };
      });
      const validationWarnings: string[] = [];
      if (paragraphs.length === 4) validationWarnings.push(`Four-paragraph structure: ${structureException}`);
      if (wordCount(paragraphs) < 140) validationWarnings.push("Body contains fewer than approximately 140 words");
      return { selectionId, editorialTitle, publicTitle, standfirst, paragraphs, structureException, claimEvidenceMap, validationWarnings };
    });
    if (new Set(candidates.map((candidate) => candidate.selectionId)).size !== candidates.length) throw new Error("candidate selection IDs must be unique");

    const artifacts = Array.isArray(body.artifacts) ? body.artifacts.map((raw, index) => {
      const item = objectValue(raw, `artifacts[${index}]`);
      return {
        artifactType: requiredString(item.artifactType, `artifacts[${index}].artifactType`, 100),
        schemaVersion: requiredString(item.schemaVersion, `artifacts[${index}].schemaVersion`, 50),
        content: objectValue(item.content, `artifacts[${index}].content`),
      };
    }) : [];

    return { ok: true, value: {
      requestId, attemptId, runId, status: "ok", operation: "transcript-to-snacks", episodeId, inputRevisionId,
      resultSchemaVersion: "1", promptSuiteVersion, pipelineVersion, declaredShortfall, evidence, candidates, artifacts,
    } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
