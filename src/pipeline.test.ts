import { describe, expect, test } from "bun:test";
import { buildEpisodePipelineTriggerRequest } from "./pipeline.ts";

describe("episode Autopilot trigger", () => {
  test("builds the versioned request and reference-based context contract", () => {
    const trigger = buildEpisodePipelineTriggerRequest({
      autopilotUrl: "https://autopilot.example/",
      autopilotTransportUrl: "http://localhost:3600",
      pipelineName: "snack studio/v2",
      requestId: "request-1",
      attemptId: "attempt-1",
      episodeId: "episode-64",
      operation: "transcript-to-snacks",
      userNpub: "npub1editor",
      inputRevisionId: "revision-3",
      pipelineVersion: "5",
      promptSuiteVersion: "v2-intelligence-snacks-pipeline",
      resultSchemaVersion: "1",
      contextUrl: "https://studio.example/api/nip98/pipeline-requests/request-1/context",
      transcriptUrl: "https://studio.example/api/nip98/pipeline-requests/request-1/transcript",
      webhookUrl: "https://studio.example/api/pipeline-webhook",
      webhookToken: "run-secret",
    });

    expect(trigger.url).toBe("https://autopilot.example/api/pipelines/triggers/http/snack%20studio%2Fv2");
    expect(trigger.transportUrl).toBe("http://localhost:3600/api/pipelines/triggers/http/snack%20studio%2Fv2");
    expect(trigger.body.input).toMatchObject({
      source: "snack-studio",
      wappId: "snack-studio",
      requestId: "request-1",
      attemptId: "attempt-1",
      episodeId: "episode-64",
      inputRevisionId: "revision-3",
      pipelineVersion: "5",
      promptSuiteVersion: "v2-intelligence-snacks-pipeline",
      localContext: { references: [
        { type: "pipeline-context", url: "https://studio.example/api/nip98/pipeline-requests/request-1/context", authorization: "" },
        { type: "transcript", url: "https://studio.example/api/nip98/pipeline-requests/request-1/transcript", authorization: "" },
      ] },
      webhook: { token: "run-secret", authHeader: "x-snack-studio-token" },
    });
  });

  test("pins the production Snack Studio definition route to the natural-prose v13 contract", () => {
    const trigger = buildEpisodePipelineTriggerRequest({
      autopilotUrl: "https://autopilot.example/",
      pipelineName: "snack-studio-transcript-to-snacks",
      requestId: "request-1",
      attemptId: "attempt-1",
      episodeId: "episode-64",
      operation: "transcript-to-snacks",
      userNpub: "npub1editor",
      inputRevisionId: "revision-3",
      pipelineVersion: "13",
      promptSuiteVersion: "v13-natural-conversational-prose",
      resultSchemaVersion: "1",
      contextUrl: "https://studio.example/context",
      transcriptUrl: "https://studio.example/transcript",
      webhookUrl: "https://studio.example/webhook",
      webhookToken: "run-secret",
    });

    expect(trigger.url).toBe("https://autopilot.example/api/pipelines/triggers/http/snack-studio-transcript-to-snacks.v13");
    expect(trigger.body.input.pipelineVersion).toBe("13");
  });

  test("uses an explicit owner namespace and pins transcript cleanup", () => {
    const trigger = buildEpisodePipelineTriggerRequest({
      autopilotUrl: "https://autopilot.example", autopilotTransportUrl: "http://localhost:3600",
      autopilotOwnerNpub: "npub1owner", pipelineName: "snack-studio-transcript-cleanup",
      requestId: "request-4", attemptId: "attempt-4", episodeId: "episode-78",
      operation: "transcript-normalization", userNpub: "npub1agent", inputRevisionId: "revision-4",
      pipelineVersion: "2", promptSuiteVersion: "v1-public-transcript-cleanup", resultSchemaVersion: "1",
      contextUrl: "https://studio.example/context", transcriptUrl: "https://studio.example/transcript",
      webhookUrl: "https://studio.example/webhook", webhookToken: "secret",
    });
    expect(trigger.url).toBe("https://autopilot.example/api/owners/npub1owner/pipelines/triggers/http/snack-studio-transcript-cleanup.v2");
    expect(trigger.transportUrl).toBe("http://localhost:3600/api/owners/npub1owner/pipelines/triggers/http/snack-studio-transcript-cleanup.v2");
    expect(trigger.body.input.userNpub).toBe("npub1agent");
  });

  test("pins targeted regeneration to its independent v3 prompt suite", () => {
    const trigger = buildEpisodePipelineTriggerRequest({
      autopilotUrl: "https://autopilot.example", pipelineName: "snack-studio-regenerate-snack",
      requestId: "request-2", attemptId: "attempt-2", episodeId: "episode-64",
      operation: "snack-regeneration", userNpub: "npub1editor", inputRevisionId: "revision-3",
      pipelineVersion: "1", promptSuiteVersion: "v3-intelligence-snacks-natural-prose",
      resultSchemaVersion: "1", contextUrl: "https://studio.example/context",
      transcriptUrl: "https://studio.example/transcript", webhookUrl: "https://studio.example/webhook", webhookToken: "secret",
    });
    expect(trigger.url).toBe("https://autopilot.example/api/pipelines/triggers/http/snack-studio-regenerate-snack.v1");
    expect(trigger.body.input).toMatchObject({ operation: "snack-regeneration", promptSuiteVersion: "v3-intelligence-snacks-natural-prose" });
  });

  test("pins publication metadata to its independent classifier", () => {
    const trigger = buildEpisodePipelineTriggerRequest({
      autopilotUrl: "https://autopilot.example", pipelineName: "snack-studio-publication-metadata",
      requestId: "request-3", attemptId: "attempt-3", episodeId: "episode-64",
      operation: "publication-metadata", userNpub: "npub1editor", inputRevisionId: "revision-3",
      pipelineVersion: "5", promptSuiteVersion: "v5-catalogued-theme-evidence",
      resultSchemaVersion: "2", contextUrl: "https://studio.example/context",
      transcriptUrl: "https://studio.example/transcript", webhookUrl: "https://studio.example/webhook", webhookToken: "secret",
    });
    expect(trigger.url).toBe("https://autopilot.example/api/pipelines/triggers/http/snack-studio-publication-metadata.v5");
    expect(trigger.body.input.operation).toBe("publication-metadata");
  });

  test("pins transcript knowledge extraction to the requested graph definition", () => {
    const trigger = buildEpisodePipelineTriggerRequest({
      autopilotUrl: "https://autopilot.example", pipelineName: "snack-studio-graph-relationships",
      requestId: "request-graph", attemptId: "attempt-graph", episodeId: "episode-67",
      operation: "publication-metadata", userNpub: "npub1editor", inputRevisionId: "revision-67",
      pipelineVersion: "9", promptSuiteVersion: "v9-normalized-governed-topics",
      resultSchemaVersion: "5", contextUrl: "https://studio.example/context",
      transcriptUrl: "https://studio.example/transcript", webhookUrl: "https://studio.example/webhook", webhookToken: "secret",
    });
    expect(trigger.url).toBe("https://autopilot.example/api/pipelines/triggers/http/snack-studio-graph-relationships.v9");
    expect(trigger.body.input).toMatchObject({ pipelineVersion: "9", promptSuiteVersion: "v9-normalized-governed-topics", resultSchemaVersion: "5" });
  });
});
