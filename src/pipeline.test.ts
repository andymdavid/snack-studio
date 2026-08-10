import { describe, expect, test } from "bun:test";
import { buildEpisodePipelineTriggerRequest } from "./pipeline.ts";

describe("episode Autopilot trigger", () => {
  test("builds the versioned request and reference-based context contract", () => {
    const trigger = buildEpisodePipelineTriggerRequest({
      autopilotUrl: "https://autopilot.example/",
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

  test("pins the production Snack Studio definition route to the accepted v3 baseline", () => {
    const trigger = buildEpisodePipelineTriggerRequest({
      autopilotUrl: "https://autopilot.example/",
      pipelineName: "snack-studio-transcript-to-snacks",
      requestId: "request-1",
      attemptId: "attempt-1",
      episodeId: "episode-64",
      operation: "transcript-to-snacks",
      userNpub: "npub1editor",
      inputRevisionId: "revision-3",
      pipelineVersion: "3",
      promptSuiteVersion: "v3-intelligence-snacks-natural-prose",
      resultSchemaVersion: "1",
      contextUrl: "https://studio.example/context",
      transcriptUrl: "https://studio.example/transcript",
      webhookUrl: "https://studio.example/webhook",
      webhookToken: "run-secret",
    });

    expect(trigger.url).toBe("https://autopilot.example/api/pipelines/triggers/http/snack-studio-transcript-to-snacks.v3");
    expect(trigger.body.input.pipelineVersion).toBe("3");
  });
});
