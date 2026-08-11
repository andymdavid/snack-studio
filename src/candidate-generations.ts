import type { SnackCandidate } from "./candidates.ts";
import type { PipelineRequest, PipelineRun } from "./pipeline-requests.ts";

export type CandidateGeneration = {
  id: string;
  pipelineRequestId: string | null;
  sequence: number;
  createdAt: number;
  candidateCount: number;
  acceptedCount: number;
  promptSuiteVersion: string | null;
  pipelineVersion: string | null;
  pipelineRunId: string | null;
};

type RequestWithRuns = PipelineRequest & { runs: PipelineRun[] };

export function buildCandidateGenerations(
  candidates: SnackCandidate[],
  pipelineRequests: RequestWithRuns[],
): CandidateGeneration[] {
  const requestsById = new Map(pipelineRequests.map((request) => [request.id, request]));
  const groups = new Map<string, SnackCandidate[]>();

  for (const candidate of candidates) {
    const key = candidate.pipelineRequestId
      || candidate.revision.pipelineRequestId
      || (candidate.revision.origin === "fixture" ? "fixture" : "legacy");
    groups.set(key, [...(groups.get(key) || []), candidate]);
  }

  return [...groups.entries()]
    .map(([id, generationCandidates]) => {
      const request = ["fixture", "legacy"].includes(id) ? null : requestsById.get(id) || null;
      const newestRun = request?.runs[0] || null;
      return {
        id,
        pipelineRequestId: request?.id || null,
        sequence: 0,
        createdAt: request?.createdAt || Math.min(...generationCandidates.map((candidate) => candidate.createdAt)),
        candidateCount: generationCandidates.length,
        acceptedCount: generationCandidates.filter((candidate) => candidate.reviewDecision === "accepted").length,
        promptSuiteVersion: request?.promptSuiteVersion || generationCandidates[0]?.revision.promptSuiteVersion || null,
        pipelineVersion: request?.pipelineVersion || generationCandidates[0]?.revision.pipelineVersion || null,
        pipelineRunId: newestRun?.autopilotRunId || generationCandidates[0]?.revision.pipelineRunId || null,
      } satisfies CandidateGeneration;
    })
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((generation, index) => ({ ...generation, sequence: index + 1 }));
}
