import { expect, test } from "bun:test";
import { transcriptContainsExactEvidence, validateSuccessfulRegenerationResult } from "./regeneration-result-input.ts";

test("validates one grounded non-destructive Snack proposal", () => {
  const result = validateSuccessfulRegenerationResult({
    requestId: "request-1", attemptId: "attempt-1", runId: "run-1", status: "ok",
    operation: "snack-regeneration", episodeId: "episode-1", candidateId: "candidate-1",
    baseRevisionId: "revision-1", inputRevisionId: "transcript-1", resultSchemaVersion: "1",
    promptSuiteVersion: "v3-intelligence-snacks-natural-prose", pipelineVersion: "1",
    evidence: [{ evidenceId: "evidence-1", start: null, end: null, excerpt: "Exact evidence" }],
    candidate: {
      selectionId: "selection-1", editorialTitle: "Editorial title", publicTitle: "Public title", standfirst: "A precise standfirst.",
      paragraphs: ["The first paragraph develops the observation naturally.", "The second paragraph explains the supported mechanism in concrete language.", "The third paragraph completes the reasoning without extending beyond its evidence."],
      structureException: null, claimEvidenceMap: [{ claim: "Supported claim", evidenceIds: ["evidence-1"] }], validationWarnings: [],
    }, rationale: "Responded to the editor's instruction without changing the underlying claim.",
  });
  expect(result.ok).toBe(true);
});

test("allows diarization markers but not omitted spoken words in exact evidence", () => {
  const transcript = "dpc (23:34)\nBut I do not have a\n\ndpc (23:37)\nComplete picture of everything there.";
  expect(transcriptContainsExactEvidence(transcript, "But I do not have a\nComplete picture of everything there.")).toBe(true);
  expect(transcriptContainsExactEvidence("First spoken words and intervening spoken words before the end.", "First spoken words before the end.")).toBe(false);
});
