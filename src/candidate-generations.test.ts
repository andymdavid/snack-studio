import { describe, expect, test } from "bun:test";
import { buildCandidateGenerations } from "./candidate-generations.ts";
import type { SnackCandidate } from "./candidates.ts";
import type { PipelineRequest, PipelineRun } from "./pipeline-requests.ts";

function candidate(id: string, requestId: string | null, createdAt: number, reviewDecision = "generated"): SnackCandidate {
  return {
    id,
    episodeId: "episode-1",
    reviewDecision: reviewDecision as SnackCandidate["reviewDecision"],
    currentRevisionId: `${id}-revision`,
    createdAt,
    updatedAt: createdAt,
    pipelineRequestId: requestId,
    selectionId: null,
    revisionCount: 1,
    revisions: [],
    revision: {
      id: `${id}-revision`, candidateId: id, revisionNumber: 1, publicTitle: id, editorialTitle: null,
      standfirst: "", bodyMarkdown: "", attribution: null, primaryTopic: null, relatedTopics: [],
      transcriptTimestamp: null, transcriptExcerpt: null, seoTitle: null, seoDescription: null,
      publicState: "draft", origin: requestId ? "pipeline" : "fixture", changeNote: null,
      createdByPubkey: null, createdAt, pipelineRequestId: requestId, pipelineRunId: null,
      sourceTranscriptRevisionId: null, promptSuiteVersion: requestId ? "v3" : null,
      pipelineVersion: requestId ? "3" : null, resultSchemaVersion: "1", structureException: null,
      claimEvidenceMap: [], validationWarnings: [],
    },
  };
}

function request(id: string, createdAt: number): PipelineRequest & { runs: PipelineRun[] } {
  return {
    id, episodeId: "episode-1", operation: "transcript-to-snacks", status: "completed",
    actorPubkey: "actor", inputTranscriptRevisionId: "transcript-1", inputTranscriptSha256: "hash",
    autopilotTargetId: "target", pipelineName: "pipeline", pipelineVersion: "3", promptSuiteVersion: "v3",
    resultSchemaVersion: "1", idempotencyKey: id, attemptCount: 1, resultAppliedAt: createdAt + 10,
    failureSummary: null, createdAt, updatedAt: createdAt + 10,
    runs: [{
      id: `${id}-run`, requestId: id, attemptNumber: 1, status: "complete", autopilotRunId: `autopilot-${id}`,
      triggerPayload: null, failureCategory: null, failureSummary: null, progressPercent: 100,
      progressLabel: null, retryOfRunId: null, triggeredAt: createdAt, completedAt: createdAt + 10,
      createdAt, updatedAt: createdAt + 10,
    }],
  };
}

describe("buildCandidateGenerations", () => {
  test("groups candidates by request and numbers successful generations chronologically", () => {
    const generations = buildCandidateGenerations([
      candidate("new-1", "request-2", 210, "accepted"),
      candidate("old-1", "request-1", 110),
      candidate("new-2", "request-2", 211),
    ], [request("request-2", 200), request("request-1", 100)]);

    expect(generations.map(({ id, sequence, candidateCount, acceptedCount }) => ({ id, sequence, candidateCount, acceptedCount }))).toEqual([
      { id: "request-1", sequence: 1, candidateCount: 1, acceptedCount: 0 },
      { id: "request-2", sequence: 2, candidateCount: 2, acceptedCount: 1 },
    ]);
    expect(generations[1]?.pipelineRunId).toBe("autopilot-request-2");
  });

  test("keeps fixture candidates in a distinct generation", () => {
    const generations = buildCandidateGenerations([candidate("fixture-1", null, 50)], []);
    expect(generations[0]).toMatchObject({ id: "fixture", pipelineRequestId: null, sequence: 1, candidateCount: 1 });
  });
});
