export function validPipelineCallback(candidateCount = 6): Record<string, unknown> {
  const evidence = Array.from({ length: candidateCount }, (_, index) => ({
    evidenceId: `evidence-${index + 1}`,
    start: `00:0${index}:00`,
    end: `00:0${index}:30`,
    excerpt: `Source excerpt ${index + 1}`,
  }));
  const candidates = Array.from({ length: candidateCount }, (_, index) => ({
    selectionId: `selection-${index + 1}`,
    editorialTitle: `Working title ${index + 1}`,
    publicTitle: `Public title ${index + 1}`,
    standfirst: `A concrete description of supported idea ${index + 1}.`,
    paragraphs: [
      `The first paragraph establishes supported idea ${index + 1} in direct language.`,
      "The second paragraph explains its mechanism with a concrete source detail.",
      "The third paragraph completes the reasoning with its remaining limit.",
    ],
    structureException: null,
    claimEvidenceMap: [{ claim: `Supported claim ${index + 1}`, evidenceIds: [`evidence-${index + 1}`] }],
  }));
  return {
    requestId: "request-1",
    attemptId: "attempt-1",
    runId: "remote-run-1",
    status: "ok",
    operation: "transcript-to-snacks",
    episodeId: "episode-64",
    inputRevisionId: "revision-1",
    resultSchemaVersion: "1",
    promptSuiteVersion: "v5-intelligence-snacks-source-character",
    pipelineVersion: "5",
    declaredShortfall: null,
    evidence,
    candidates,
    artifacts: [{ artifactType: "selection-manifests", schemaVersion: "1", content: { selections: [] } }],
  };
}
