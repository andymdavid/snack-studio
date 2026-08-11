import { ALLOW_MOCK, HTTP_TRIGGER_TOKEN, PIPELINE_NAME, WEBHOOK_SECRET, WINGMAN_URL } from "./config.ts";
import type { Message } from "./db.ts";

export type PipelineStartInput = {
  chatId: string;
  userPubkey: string;
  userNpub: string;
  message: string;
  history: Array<Pick<Message, "role" | "content" | "createdAt">>;
  webhookUrl: string;
  webhookToken: string;
  autopilotTargetId?: string;
  autopilotLabel?: string;
  autopilotUrl?: string;
  pipelineName?: string;
};

export type PipelineStartResult = {
  mode: "autopilot-http" | "mock";
  runId: string;
  status: "running" | "mocked";
};

export type PipelineTriggerRequest = {
  url: string;
  method: "POST";
  body: {
    input: {
      source: "snack-studio";
      chatId: string;
      autopilotTargetId?: string;
      autopilotLabel?: string;
      pipelineName: string;
      userPubkey: string;
      userNpub: string;
      message: string;
      history: Array<Pick<Message, "role" | "content" | "createdAt">>;
      webhook: {
        url: string;
        token: string;
        authHeader: "x-snack-studio-token";
      };
    };
  };
};

export type EpisodePipelineTriggerRequest = {
  url: string;
  method: "POST";
  body: {
    input: {
      source: "snack-studio";
      wappId: "snack-studio";
      appId: "snack-studio";
      requestId: string;
      attemptId: string;
      episodeId: string;
      operation: "transcript-to-snacks" | "transcript-normalization" | "snack-regeneration" | "publication-metadata";
      userNpub: string;
      inputRevisionId: string;
      pipelineVersion: string | null;
      promptSuiteVersion: string;
      resultSchemaVersion: string;
      localContext: {
        references: Array<{
          type: "pipeline-context" | "transcript";
          url: string;
          authorization: string;
        }>;
      };
      webhook: {
        url: string;
        token: string;
        authHeader: "x-snack-studio-token";
      };
    };
  };
};

export function buildPipelineTriggerRequest(input: PipelineStartInput): PipelineTriggerRequest {
  const autopilotUrl = (input.autopilotUrl || WINGMAN_URL).replace(/\/$/, "");
  const pipelineName = input.pipelineName || PIPELINE_NAME;
  const url = new URL(`/api/pipelines/triggers/http/${encodeURIComponent(pipelineName)}`, autopilotUrl);
  return {
    url: url.toString(),
    method: "POST",
    body: {
      input: {
        source: "snack-studio",
        chatId: input.chatId,
        autopilotTargetId: input.autopilotTargetId,
        autopilotLabel: input.autopilotLabel,
        pipelineName,
        userPubkey: input.userPubkey,
        userNpub: input.userNpub,
        message: input.message,
        history: input.history,
        webhook: {
          url: input.webhookUrl,
          token: input.webhookToken,
          authHeader: "x-snack-studio-token",
        },
      },
    },
  };
}

export async function startChatPipeline(input: PipelineStartInput, authorization?: string): Promise<PipelineStartResult> {
  return startPreparedChatPipeline(buildPipelineTriggerRequest(input), authorization);
}

export async function startPreparedChatPipeline(trigger: PipelineTriggerRequest, authorization?: string): Promise<PipelineStartResult> {
  const input = trigger.body.input;
  try {
    return await startAutopilotHttpPipeline(trigger, authorization);
  } catch (error) {
    if (!ALLOW_MOCK) throw error;
    return startMockPipeline({
      chatId: input.chatId,
      userPubkey: input.userPubkey,
      userNpub: input.userNpub,
      message: input.message,
      history: input.history,
      webhookUrl: input.webhook.url,
      webhookToken: input.webhook.token,
    }, error);
  }
}

export function buildEpisodePipelineTriggerRequest(input: {
  autopilotUrl: string;
  pipelineName: string;
  requestId: string;
  attemptId: string;
  episodeId: string;
  operation: EpisodePipelineTriggerRequest["body"]["input"]["operation"];
  userNpub: string;
  inputRevisionId: string;
  pipelineVersion: string | null;
  promptSuiteVersion: string;
  resultSchemaVersion: string;
  contextUrl: string;
  transcriptUrl: string;
  webhookUrl: string;
  webhookToken: string;
}): EpisodePipelineTriggerRequest {
  // Pin Snack Studio's numbered production definitions at the HTTP boundary.
  // The version is also retained in the payload for provenance, but Autopilot
  // resolves the definition from the route rather than from input metadata.
  const pipelineName = input.pipelineVersion
    && ["snack-studio-transcript-to-snacks", "snack-studio-regenerate-snack", "snack-studio-publication-metadata"].includes(input.pipelineName)
    ? `${input.pipelineName}.v${input.pipelineVersion}`
    : input.pipelineName;
  return {
    url: new URL(`/api/pipelines/triggers/http/${encodeURIComponent(pipelineName)}`, input.autopilotUrl.replace(/\/$/, "")).toString(),
    method: "POST",
    body: {
      input: {
        source: "snack-studio",
        wappId: "snack-studio",
        appId: "snack-studio",
        requestId: input.requestId,
        attemptId: input.attemptId,
        episodeId: input.episodeId,
        operation: input.operation,
        userNpub: input.userNpub,
        inputRevisionId: input.inputRevisionId,
        pipelineVersion: input.pipelineVersion,
        promptSuiteVersion: input.promptSuiteVersion,
        resultSchemaVersion: input.resultSchemaVersion,
        localContext: {
          references: [
            { type: "pipeline-context", url: input.contextUrl, authorization: "" },
            { type: "transcript", url: input.transcriptUrl, authorization: "" },
          ],
        },
        webhook: {
          url: input.webhookUrl,
          token: input.webhookToken,
          authHeader: "x-snack-studio-token",
        },
      },
    },
  };
}

export async function startPreparedEpisodePipeline(trigger: EpisodePipelineTriggerRequest, authorization: string): Promise<PipelineStartResult> {
  return startAutopilotHttpPipeline(trigger, authorization);
}

async function startAutopilotHttpPipeline(trigger: PipelineTriggerRequest | EpisodePipelineTriggerRequest, authorization?: string): Promise<PipelineStartResult> {
  const res = await fetch(trigger.url, {
    method: trigger.method,
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : HTTP_TRIGGER_TOKEN ? { authorization: `Bearer ${HTTP_TRIGGER_TOKEN}` } : {}),
    },
    body: JSON.stringify(trigger.body),
  });
  const payload = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    const detail = typeof payload.error === "string" ? payload.error : res.statusText;
    throw new Error(`Autopilot trigger failed (${res.status}): ${detail}`);
  }
  const run = payload.run && typeof payload.run === "object" ? payload.run as Record<string, unknown> : {};
  return {
    mode: "autopilot-http",
    runId: String(run.id ?? payload.runId ?? crypto.randomUUID()),
    status: "running",
  };
}

function startMockPipeline(input: PipelineStartInput, cause: unknown): PipelineStartResult {
  const runId = `mock-${crypto.randomUUID()}`;
  const reason = cause instanceof Error ? cause.message : String(cause);
  setTimeout(async () => {
    const content = [
      `Mock pipeline response for: ${input.message}`,
      "",
      "The WApp stored the chat locally, created a pending assistant message, and delivered this through the same webhook the real pipeline agent will call.",
      `Autopilot trigger fallback reason: ${reason}`,
    ].join("\n");
    await fetch(input.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-snack-studio-token": input.webhookToken,
        "x-snack-studio-signature": WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        chatId: input.chatId,
        runId,
        status: "ok",
        response: content,
        metadata: { mode: "mock", fallbackReason: reason },
      }),
    }).catch(() => undefined);
  }, 900);
  return { mode: "mock", runId, status: "mocked" };
}
