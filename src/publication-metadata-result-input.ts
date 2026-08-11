import { resolveCanonicalTopic } from "./publication-metadata.ts";

export type SuccessfulPublicationMetadataResult = {
  requestId: string;
  attemptId: string;
  runId: string | null;
  episodeId: string;
  operation: "publication-metadata";
  inputRevisionId: string;
  resultSchemaVersion: string;
  pipelineVersion: string;
  assignments: Array<{
    candidateId: string;
    revisionId: string;
    primaryTopic: string;
    rationale: string;
  }>;
};

export function validateSuccessfulPublicationMetadataResult(value: Record<string, unknown>):
  | { ok: true; value: SuccessfulPublicationMetadataResult }
  | { ok: false; error: string } {
  try {
    const required = (key: string) => {
      const item = typeof value[key] === "string" ? String(value[key]).trim() : "";
      if (!item) throw new Error(`${key} is required`);
      return item;
    };
    if (value.operation !== "publication-metadata") throw new Error("operation must be publication-metadata");
    if (!Array.isArray(value.assignments) || !value.assignments.length) throw new Error("assignments are required");
    const assignments = value.assignments.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`assignment ${index + 1} must be an object`);
      const row = item as Record<string, unknown>;
      const candidateId = typeof row.candidateId === "string" ? row.candidateId.trim() : "";
      const revisionId = typeof row.revisionId === "string" ? row.revisionId.trim() : "";
      const topic = resolveCanonicalTopic(typeof row.primaryTopic === "string" ? row.primaryTopic : null);
      const rationale = typeof row.rationale === "string" ? row.rationale.trim().slice(0, 500) : "";
      if (!candidateId || !revisionId) throw new Error(`assignment ${index + 1} requires candidateId and revisionId`);
      if (!topic) throw new Error(`assignment ${index + 1} uses an unknown canonical topic`);
      if (!rationale) throw new Error(`assignment ${index + 1} requires a rationale`);
      return { candidateId, revisionId, primaryTopic: topic.id, rationale };
    });
    if (new Set(assignments.map(({ candidateId }) => candidateId)).size !== assignments.length) throw new Error("assignments contain duplicate candidates");
    return { ok: true, value: {
      requestId: required("requestId"), attemptId: required("attemptId"),
      runId: typeof value.runId === "string" && value.runId.trim() ? value.runId.trim() : null,
      episodeId: required("episodeId"), operation: "publication-metadata",
      inputRevisionId: required("inputRevisionId"), resultSchemaVersion: required("resultSchemaVersion"),
      pipelineVersion: required("pipelineVersion"), assignments,
    } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
