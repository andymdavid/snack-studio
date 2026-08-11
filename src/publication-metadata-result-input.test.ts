import { expect, test } from "bun:test";
import { validateSuccessfulPublicationMetadataResult } from "./publication-metadata-result-input.ts";

const result = {
  requestId: "request-1", attemptId: "attempt-1", episodeId: "episode-1",
  operation: "publication-metadata", inputRevisionId: "transcript-1",
  resultSchemaVersion: "1", pipelineVersion: "1",
  assignments: [{ candidateId: "candidate-1", revisionId: "revision-1", primaryTopic: "AI Coding", rationale: "The Snack focuses on coding-agent practice." }],
};

test("validates canonical publication topic assignments", () => {
  const validation = validateSuccessfulPublicationMetadataResult(result);
  expect(validation.ok).toBe(true);
  if (validation.ok) expect(validation.value.assignments[0]?.primaryTopic).toBe("ai-coding");
});

test("rejects topics outside the website taxonomy", () => {
  expect(validateSuccessfulPublicationMetadataResult({ ...result, assignments: [{ ...result.assignments[0], primaryTopic: "General AI" }] })).toEqual({ ok: false, error: "assignment 1 uses an unknown canonical topic" });
});
