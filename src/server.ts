import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { Event as NostrEvent } from "nostr-tools";
import {
  addAccessRule,
  canLogin,
  cleanupExpiredAuthRows,
  createChallenge,
  getAccessRules,
  getSession,
  hasAccess,
  normalizePubkey,
  pubkeyToNpub,
  removeAccessRule,
  verifyLoginEvent,
} from "./auth.ts";
import { verifyNip98Request } from "./nip98.ts";
import { PIPELINE_NAME, PIPELINE_TIMEOUT_MS, PORT, PUBLIC_ORIGIN, WINGMAN_URL } from "./config.ts";
import {
  db,
  deleteAutopilotTarget,
  getAutopilotTarget,
  getCurrentAutopilotTarget,
  getSetting,
  listAutopilotTargets,
  mapChat,
  mapMessage,
  setSetting,
  upsertAutopilotTarget,
  type AccessRole,
  type AppSettings,
  type AutopilotTarget,
  type Message,
} from "./db.ts";
import { clearPendingImport, exportSnapshot, getDbStatus, snapshotPath, stageSnapshotImport, stageUploadedImport } from "./db-admin.ts";
import { validateEpisodeInput } from "./episode-input.ts";
import { validateCandidateRevision, validateReviewDecision } from "./candidate-input.ts";
import { activateCandidateRevision, approveCandidateBatch, createCandidateRevision, generateFixtureCandidates, getCandidate, listCandidates, setApprovedCandidateOrder, updateCandidateDecision, validateApprovedCandidateBatch } from "./candidates.ts";
import { buildCandidateGenerations } from "./candidate-generations.ts";
import { createFixtureRelationshipSuggestions, createRelationship, deleteRelationship, getCuration, RELATIONSHIP_TYPES, setNewsletterItems, updateRelationshipState } from "./curation.ts";
import { normalizeTranscriptText, validateEpisodeMetadata, validateTranscriptUpload } from "./transcript-input.ts";
import {
  activateTranscriptRevision,
  createEpisode,
  createPastedTranscriptRevision,
  createUploadedTranscriptRevision,
  deleteEpisodeWorkspace,
  findEpisodeByNumber,
  getActiveTranscriptRevision,
  getEpisode,
  listEpisodeAuditEvents,
  listEpisodes,
  listTranscriptRevisions,
  recordAuditEvent,
  updateEpisodeMetadata,
} from "./episodes.ts";
import {
  buildEpisodePipelineTriggerRequest,
  buildPipelineTriggerRequest,
  startPreparedChatPipeline,
  startPreparedEpisodePipeline,
  type EpisodePipelineTriggerRequest,
  type PipelineTriggerRequest,
} from "./pipeline.ts";
import {
  createPipelineRun,
  createPipelineRequest,
  cancelUnstartedPipelineRuns,
  getPipelineRequest,
  getPipelineRequestContext,
  getPipelineRequestTranscript,
  getPipelineRun,
  findPipelineRunForCallback,
  listEpisodePipelineRequests,
  markPipelineRunFailed,
  markPipelineRunStarted,
  markPipelineResultRejected,
  markStalePipelineRunsTimedOut,
  PIPELINE_OPERATIONS,
  type PipelineOperation,
  verifyPreparedPipelineTrigger,
  updatePipelineRunProgress,
} from "./pipeline-requests.ts";
import { validateSuccessfulPipelineResult } from "./pipeline-result-input.ts";
import { applySuccessfulPipelineResult } from "./pipeline-results.ts";
import { applySuccessfulRegenerationResult, listRegenerationProposals, resolveRegenerationProposal } from "./regeneration-proposals.ts";
import { validateSuccessfulRegenerationResult } from "./regeneration-result-input.ts";
import { validateThumbnailBrief } from "./thumbnail-input.ts";
import { createThumbnailJob, getPublicationPreparation, listThumbnailJobs, preparePublicationThumbnails } from "./thumbnails.ts";
import { THUMBNAIL_CANDIDATES_PER_ROUND, THUMBNAIL_TOPICS } from "./thumbnail-catalog.ts";
import { validateSuccessfulPublicationMetadataResult } from "./publication-metadata-result-input.ts";
import { applySuccessfulPublicationMetadataResult } from "./publication-metadata-results.ts";
import { createContributor, getContributor, listContributors, photoMediaType, publicContributor } from "./contributors.ts";
import { validateContributorPhoto, validateContributorProfile } from "./contributor-input.ts";
import { approvePortraitCandidate, applyPortraitResult, createPortraitJob, getPortraitCandidate, listPortraitJobs, markPortraitJobStarted } from "./contributor-portraits.ts";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");

setInterval(cleanupExpiredAuthRows, 15 * 60 * 1000);

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const text = (data: string, status = 200) =>
  new Response(data, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const value = await req.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function serveStatic(pathname: string): Promise<Response> {
  const relativePath = pathname === "/" ? "/index.html" : pathname;
  const file = Bun.file(join(PUBLIC_DIR, relativePath));
  if (await file.exists()) return new Response(file, { headers: { "cache-control": "no-store" } });
  const fallback = Bun.file(join(PUBLIC_DIR, "index.html"));
  if (await fallback.exists()) return new Response(fallback, { headers: { "cache-control": "no-store" } });
  return text("public/index.html missing", 500);
}

function requireSession(req: Request) {
  const session = getSession(req);
  if (!session) return null;
  return session;
}

function getAppSettings(): AppSettings {
  const targets = listAutopilotTargets();
  const selected = getCurrentAutopilotTarget();
  return {
    autopilotUrl: selected.url || (getSetting("autopilotUrl") || WINGMAN_URL).replace(/\/$/, ""),
    defaultPipeline: selected.defaultPipeline || getSetting("defaultPipeline") || PIPELINE_NAME,
    currentAutopilotTargetId: selected.id,
    autopilotTargets: targets,
  };
}

function normalizeAutopilotUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value.trim());
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function configuredAutopilotPublicHosts(): Set<string> {
  const hosts = new Set<string>(["rick.runwingman.com"]);
  for (const value of [
    process.env.WAPP_AUTOPILOT_PUBLIC_URL,
    process.env.WINGMAN_PUBLIC_URL,
    process.env.PUBLIC_WINGMAN_URL,
  ]) {
    if (!value?.trim()) continue;
    try {
      hosts.add(new URL(value.trim()).hostname);
    } catch {
      hosts.add(value.trim());
    }
  }
  return hosts;
}

function resolveAutopilotServerUrl(value: string | null | undefined): string {
  const normalized = normalizeAutopilotUrl(value) || WINGMAN_URL;
  try {
    const url = new URL(normalized);
    if (configuredAutopilotPublicHosts().has(url.hostname)) {
      return WINGMAN_URL;
    }
  } catch {
    return WINGMAN_URL;
  }
  return normalized;
}

function normalizePipelineName(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getRequestedAutopilotTarget(value: unknown): AutopilotTarget {
  const targetId = typeof value === "string" && value.trim() ? value.trim() : getAppSettings().currentAutopilotTargetId;
  return getAutopilotTarget(targetId) || getCurrentAutopilotTarget();
}

function buildAutopilotPipelinesRequest(target = getCurrentAutopilotTarget()) {
  return {
    url: new URL("/api/pipelines/definitions", resolveAutopilotServerUrl(target.url)).toString(),
    method: "GET" as const,
  };
}

function normalizeAccessRole(value: unknown): AccessRole | null {
  return value === "read" || value === "edit" ? value : null;
}

function requireEditSession(req: Request) {
  const session = requireSession(req);
  if (!session) return null;
  return hasAccess(session.pubkey, "edit") ? session : null;
}

function getChatForUser(chatId: string, pubkey: string) {
  const row = db.query("SELECT * FROM chats WHERE id = ?1 AND pubkey = ?2").get(chatId, pubkey) as Record<string, unknown> | null;
  return row ? mapChat(row) : null;
}

function listMessages(chatId: string, pubkey: string): Message[] {
  const rows = db.query("SELECT * FROM messages WHERE chat_id = ?1 AND pubkey = ?2 ORDER BY created_at ASC").all(chatId, pubkey) as Record<string, unknown>[];
  return rows.map(mapMessage);
}

function updateChatTitle(chatId: string, title: string) {
  db.query("UPDATE chats SET title = ?1, updated_at = ?2 WHERE id = ?3").run(title.slice(0, 80), Date.now(), chatId);
}

function webhookOrigin(req: Request): string {
  return PUBLIC_ORIGIN || new URL(req.url).origin;
}

function prepareEpisodePipelineRun(req: Request, pipelineRequest: NonNullable<ReturnType<typeof getPipelineRequest>>, userNpub: string, retryOfRunId?: string | null) {
  const target = getAutopilotTarget(pipelineRequest.autopilotTargetId);
  if (!target) throw new Error("configured Autopilot target no longer exists");
  const contextUrl = `${webhookOrigin(req)}/api/nip98/pipeline-requests/${encodeURIComponent(pipelineRequest.id)}/context`;
  const transcriptUrl = `${webhookOrigin(req)}/api/nip98/pipeline-requests/${encodeURIComponent(pipelineRequest.id)}/transcript`;
  const callbackUrl = `${webhookOrigin(req)}/api/pipeline-webhook`;
  const autopilotUrl = resolveAutopilotServerUrl(target.url);
  return createPipelineRun({
    requestId: pipelineRequest.id,
    retryOfRunId: retryOfRunId ?? null,
    buildTriggerPayload: (callbackToken, attemptId) => buildEpisodePipelineTriggerRequest({
      autopilotUrl,
      pipelineName: pipelineRequest.pipelineName,
      requestId: pipelineRequest.id,
      attemptId,
      episodeId: pipelineRequest.episodeId,
      operation: pipelineRequest.operation,
      userNpub,
      inputRevisionId: pipelineRequest.inputTranscriptRevisionId,
      pipelineVersion: pipelineRequest.pipelineVersion,
      promptSuiteVersion: pipelineRequest.promptSuiteVersion,
      resultSchemaVersion: pipelineRequest.resultSchemaVersion,
      contextUrl,
      transcriptUrl,
      webhookUrl: callbackUrl,
      webhookToken: callbackToken,
    }) as unknown as Record<string, unknown>,
  });
}

async function handleApi(req: Request, url: URL): Promise<Response | null> {
  const { pathname } = url;

  if (pathname === "/api/health" && req.method === "GET") {
    return json({ ok: true, app: "snack-studio", now: new Date().toISOString() });
  }

  if (pathname === "/api/auth/challenge" && req.method === "POST") {
    const body = await readJson(req);
    const pubkey = normalizePubkey(String(body.pubkey ?? ""));
    if (!pubkey) return json({ error: "pubkey must be a 64-char hex key or npub" }, 400);
    return json({ pubkey, npub: pubkeyToNpub(pubkey), ...createChallenge(pubkey) });
  }

  if (pathname === "/api/auth/verify" && req.method === "POST") {
    const body = await readJson(req);
    const event = body.event;
    if (!event || typeof event !== "object" || Array.isArray(event)) return json({ error: "event is required" }, 400);
    const result = verifyLoginEvent(event as NostrEvent);
    return result.ok ? json(result) : json({ error: result.error }, 401);
  }

  if (pathname === "/api/me" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    return json({
      pubkey: session.pubkey,
      npub: pubkeyToNpub(session.pubkey),
      expiresAt: session.expiresAt,
      access: {
        login: canLogin(session.pubkey),
        read: hasAccess(session.pubkey, "read"),
        edit: hasAccess(session.pubkey, "edit"),
      },
    });
  }

  if (pathname === "/api/settings" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    return json({ settings: getAppSettings(), accessRules: getAccessRules() });
  }

  if (pathname === "/api/settings" && req.method === "PUT") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const targetId = typeof body.autopilotTargetId === "string" && body.autopilotTargetId.trim()
      ? body.autopilotTargetId.trim()
      : getAppSettings().currentAutopilotTargetId;
    const existingTarget = getAutopilotTarget(targetId) || getCurrentAutopilotTarget();
    const label = typeof body.autopilotLabel === "string" && body.autopilotLabel.trim() ? body.autopilotLabel.trim() : existingTarget.label;
    const autopilotUrl = body.autopilotUrl === undefined ? null : normalizeAutopilotUrl(body.autopilotUrl);
    const defaultPipeline = body.defaultPipeline === undefined ? null : normalizePipelineName(body.defaultPipeline);
    if (body.autopilotUrl !== undefined && !autopilotUrl) return json({ error: "autopilotUrl must be a valid http(s) URL" }, 400);
    if (body.defaultPipeline !== undefined && !defaultPipeline) return json({ error: "defaultPipeline is required" }, 400);
    const updated = upsertAutopilotTarget({
      id: existingTarget.id,
      label,
      url: autopilotUrl || existingTarget.url,
      defaultPipeline: defaultPipeline || existingTarget.defaultPipeline,
    });
    setSetting("currentAutopilotTargetId", updated.id);
    recordAuditEvent({
      actorPubkey: session.pubkey,
      action: "settings.autopilot.updated",
      entityType: "autopilot-target",
      entityId: updated.id,
      detail: { label: updated.label, defaultPipeline: updated.defaultPipeline },
    });
    return json({ settings: getAppSettings() });
  }

  if (pathname === "/api/episodes" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasAccess(session.pubkey, "read")) return json({ error: "read access required" }, 403);
    return json({ episodes: listEpisodes() });
  }

  if (pathname === "/api/thumbnail-options" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasAccess(session.pubkey, "read")) return json({ error: "read access required" }, 403);
    return json({
      contributors: listContributors().map(publicContributor),
      topics: THUMBNAIL_TOPICS,
      candidatesPerRound: THUMBNAIL_CANDIDATES_PER_ROUND,
    });
  }

  if (pathname === "/api/contributors" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasAccess(session.pubkey, "read")) return json({ error: "read access required" }, 403);
    return json({ contributors: listContributors().map(publicContributor) });
  }

  if (pathname === "/api/contributors" && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    try {
      const form = await req.formData();
      const input = validateContributorProfile(form);
      const photo = form.get('photo');
      if (!(photo instanceof File)) throw new Error('A reference photo is required');
      validateContributorPhoto(photo);
      return json({ contributor: publicContributor(await createContributor({ ...input, actorPubkey: session.pubkey, photo })) }, 201);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  const contributorPhotoMatch = pathname.match(/^\/api\/contributors\/([^/]+)\/reference-photo$/);
  if (contributorPhotoMatch && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasAccess(session.pubkey, "read")) return json({ error: "read access required" }, 403);
    const contributor = getContributor(decodeURIComponent(contributorPhotoMatch[1]!));
    if (!contributor?.referencePhotoPath) return json({ error: "reference photo not found" }, 404);
    try {
      return new Response(readFileSync(contributor.referencePhotoPath), { headers: { 'content-type': photoMediaType(contributor.referencePhotoPath), 'cache-control': 'private, max-age=300' } });
    } catch {
      return json({ error: "reference photo not found" }, 404);
    }
  }

  const contributorPortraitJobsMatch = pathname.match(/^\/api\/contributors\/([^/]+)\/portrait-jobs$/);
  if (contributorPortraitJobsMatch && req.method === 'GET') {
    const session = requireSession(req);
    if (!session) return json({ error: 'unauthorized' }, 401);
    if (!hasAccess(session.pubkey, 'read')) return json({ error: 'read access required' }, 403);
    return json({ jobs: listPortraitJobs(decodeURIComponent(contributorPortraitJobsMatch[1]!)) });
  }
  if (contributorPortraitJobsMatch && req.method === 'POST') {
    const session = requireEditSession(req);
    if (!session) return json({ error: 'edit access required' }, 403);
    try { return json(createPortraitJob(decodeURIComponent(contributorPortraitJobsMatch[1]!), session.pubkey, new URL(req.url).origin), 201); }
    catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 400); }
  }

  const portraitJobStartMatch = pathname.match(/^\/api\/contributor-portrait-jobs\/([^/]+)\/started$/);
  if (portraitJobStartMatch && req.method === 'POST') {
    const session = requireEditSession(req);
    if (!session) return json({ error: 'edit access required' }, 403);
    const body = await readJson(req);
    const runId = String(body.autopilotRunId || '');
    if (!runId) return json({ error: 'autopilotRunId is required' }, 400);
    markPortraitJobStarted(decodeURIComponent(portraitJobStartMatch[1]!), runId);
    return json({ ok: true });
  }

  const portraitCandidateImageMatch = pathname.match(/^\/api\/contributor-portrait-candidates\/([^/]+)\/image$/);
  if (portraitCandidateImageMatch && req.method === 'GET') {
    const session = requireSession(req);
    if (!session) return json({ error: 'unauthorized' }, 401);
    if (!hasAccess(session.pubkey, 'read')) return json({ error: 'read access required' }, 403);
    const candidate = getPortraitCandidate(decodeURIComponent(portraitCandidateImageMatch[1]!));
    if (!candidate) return json({ error: 'portrait candidate not found' }, 404);
    const file = Bun.file(String(candidate.storage_path));
    if (!await file.exists()) return json({ error: 'portrait image not found' }, 404);
    return new Response(file, { headers: { 'content-type': String(candidate.mime_type), 'cache-control': 'private, max-age=300' } });
  }

  const portraitCandidateApproveMatch = pathname.match(/^\/api\/contributor-portrait-candidates\/([^/]+)\/approve$/);
  if (portraitCandidateApproveMatch && req.method === 'POST') {
    const session = requireEditSession(req);
    if (!session) return json({ error: 'edit access required' }, 403);
    try { return json({ contributor: publicContributor(approvePortraitCandidate(decodeURIComponent(portraitCandidateApproveMatch[1]!), session.pubkey)) }); }
    catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 400); }
  }

  const portraitWebhookMatch = pathname.match(/^\/api\/contributor-portrait-webhooks\/([^/]+)$/);
  if (portraitWebhookMatch && req.method === 'POST') {
    const token = req.headers.get('x-snack-studio-token') || '';
    try {
      applyPortraitResult(decodeURIComponent(portraitWebhookMatch[1]!), token, await readJson(req));
      return json({ ok: true });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  if (pathname === "/api/episodes" && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const validated = validateEpisodeInput(body);
    if (!validated.ok) return json({ error: validated.error }, 400);
    const { episodeNumber, workingTitle } = validated.value;
    if (episodeNumber !== null && findEpisodeByNumber(episodeNumber)) {
      return json({ error: `Episode ${episodeNumber} already has a workspace` }, 409);
    }
    return json({ episode: createEpisode({ episodeNumber, workingTitle, ownerPubkey: session.pubkey }) }, 201);
  }

  const episodeMatch = pathname.match(/^\/api\/episodes\/([^/]+)$/);
  if (episodeMatch && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasAccess(session.pubkey, "read")) return json({ error: "read access required" }, 403);
    const episode = getEpisode(decodeURIComponent(episodeMatch[1]!));
    if (!episode) return json({ error: "episode not found" }, 404);
    return json({
      episode,
      transcript: getActiveTranscriptRevision(episode.id),
      transcriptRevisions: listTranscriptRevisions(episode.id),
      auditEvents: listEpisodeAuditEvents(episode.id),
    });
  }

  if (episodeMatch && req.method === "PATCH") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const episodeId = decodeURIComponent(episodeMatch[1]!);
    if (!getEpisode(episodeId)) return json({ error: "episode not found" }, 404);
    const validated = validateEpisodeMetadata(await readJson(req));
    if (!validated.ok) return json({ error: validated.error }, 400);
    if (validated.value.episodeNumber !== null) {
      const duplicate = findEpisodeByNumber(validated.value.episodeNumber);
      if (duplicate && duplicate.id !== episodeId) {
        return json({ error: `Episode ${validated.value.episodeNumber} already has a workspace` }, 409);
      }
    }
    const episode = updateEpisodeMetadata(episodeId, { ...validated.value, actorPubkey: session.pubkey });
    return json({ episode });
  }

  if (episodeMatch && req.method === "DELETE") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const episodeId = decodeURIComponent(episodeMatch[1]!);
    const result = deleteEpisodeWorkspace(episodeId);
    if (result === "not-found") return json({ error: "episode not found" }, 404);
    if (result === "pipeline-active") {
      return json({ error: "This workspace cannot be deleted while generation is running" }, 409);
    }
    return json({ ok: true, episodeId });
  }

  const transcriptRevisionMatch = pathname.match(/^\/api\/episodes\/([^/]+)\/transcript-revisions$/);
  if (transcriptRevisionMatch && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const episodeId = decodeURIComponent(transcriptRevisionMatch[1]!);
    if (!getEpisode(episodeId)) return json({ error: "episode not found" }, 404);
    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return json({ error: "file is required" }, 400);
      const validatedFile = validateTranscriptUpload(file);
      if (!validatedFile.ok) return json({ error: validatedFile.error }, 400);
      const sourceBytes = new Uint8Array(await file.arrayBuffer());
      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
      } catch {
        return json({ error: "Transcript uploads must contain valid UTF-8 text" }, 400);
      }
      if (decoded.includes("\u0000")) return json({ error: "Transcript uploads cannot contain null bytes" }, 400);
      const normalized = normalizeTranscriptText(decoded);
      if (!normalized.ok) return json({ error: normalized.error }, 400);
      const rawNote = form.get("changeNote");
      const changeNote = typeof rawNote === "string" && rawNote.trim() ? rawNote.trim().slice(0, 500) : null;
      const originalFilename = file.name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255) || "transcript.txt";
      const transcript = createUploadedTranscriptRevision({
        episodeId,
        originalFilename,
        mediaType: file.type || "text/plain",
        sourceBytes,
        transcriptText: normalized.text,
        changeNote,
        actorPubkey: session.pubkey,
      });
      return json({
        episode: getEpisode(episodeId),
        transcript,
        transcriptRevisions: listTranscriptRevisions(episodeId),
        auditEvents: listEpisodeAuditEvents(episodeId),
      }, 201);
    }
    const body = await readJson(req);
    const normalized = normalizeTranscriptText(body.transcriptText);
    if (!normalized.ok) return json({ error: normalized.error }, 400);
    const changeNote = typeof body.changeNote === "string" && body.changeNote.trim()
      ? body.changeNote.trim().slice(0, 500)
      : null;
    const transcript = createPastedTranscriptRevision({
      episodeId,
      transcriptText: normalized.text,
      sizeBytes: normalized.sizeBytes,
      changeNote,
      actorPubkey: session.pubkey,
    });
    return json({
      episode: getEpisode(episodeId),
      transcript,
      transcriptRevisions: listTranscriptRevisions(episodeId),
      auditEvents: listEpisodeAuditEvents(episodeId),
    }, 201);
  }

  const activateTranscriptMatch = pathname.match(/^\/api\/episodes\/([^/]+)\/transcript-revisions\/([^/]+)\/active$/);
  if (activateTranscriptMatch && req.method === "PUT") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const episodeId = decodeURIComponent(activateTranscriptMatch[1]!);
    const revisionId = decodeURIComponent(activateTranscriptMatch[2]!);
    if (!getEpisode(episodeId)) return json({ error: "episode not found" }, 404);
    const transcript = activateTranscriptRevision({ episodeId, revisionId, actorPubkey: session.pubkey });
    if (!transcript) return json({ error: "transcript revision not found for this episode" }, 404);
    return json({
      episode: getEpisode(episodeId),
      transcript,
      transcriptRevisions: listTranscriptRevisions(episodeId),
      auditEvents: listEpisodeAuditEvents(episodeId),
    });
  }

  const episodeCandidatesMatch = pathname.match(/^\/api\/episodes\/([^/]+)\/candidates$/);
  if (episodeCandidatesMatch && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasAccess(session.pubkey, "read")) return json({ error: "read access required" }, 403);
    const episodeId = decodeURIComponent(episodeCandidatesMatch[1]!);
    if (!getEpisode(episodeId)) return json({ error: "episode not found" }, 404);
    const candidates = listCandidates(episodeId);
    return json({
      candidates,
      generations: buildCandidateGenerations(candidates, listEpisodePipelineRequests(episodeId)),
      approvedBatch: validateApprovedCandidateBatch(episodeId),
      regenerationProposals: Object.fromEntries(candidates.map((candidate) => [candidate.id, listRegenerationProposals(candidate.id)])),
    });
  }

  const episodeThumbnailsMatch = pathname.match(/^\/api\/episodes\/([^/]+)\/thumbnails$/);
  if (episodeThumbnailsMatch && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasAccess(session.pubkey, "read")) return json({ error: "read access required" }, 403);
    const episodeId = decodeURIComponent(episodeThumbnailsMatch[1]!);
    if (!getEpisode(episodeId)) return json({ error: "episode not found" }, 404);
    return json({ thumbnailJobs: listThumbnailJobs(episodeId) });
  }

  if (episodeThumbnailsMatch && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const episodeId = decodeURIComponent(episodeThumbnailsMatch[1]!);
    if (!getEpisode(episodeId)) return json({ error: "episode not found" }, 404);
    try {
      const brief = validateThumbnailBrief(await readJson(req));
      return json({ thumbnailJob: createThumbnailJob({ ...brief, episodeId, actorPubkey: session.pubkey }) }, 201);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  const publicationPreparationMatch = pathname.match(/^\/api\/episodes\/([^/]+)\/publication-preparation$/);
  if (publicationPreparationMatch && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasAccess(session.pubkey, "read")) return json({ error: "read access required" }, 403);
    try {
      return json({ preparation: getPublicationPreparation(decodeURIComponent(publicationPreparationMatch[1]!)) });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  }

  if (publicationPreparationMatch && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const episodeId = decodeURIComponent(publicationPreparationMatch[1]!);
    try {
      return json({ preparation: preparePublicationThumbnails(episodeId, session.pubkey) });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  }

  const fixtureCandidatesMatch = pathname.match(/^\/api\/episodes\/([^/]+)\/fixture-candidates$/);
  if (fixtureCandidatesMatch && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const episodeId = decodeURIComponent(fixtureCandidatesMatch[1]!);
    const episode = getEpisode(episodeId);
    if (!episode) return json({ error: "episode not found" }, 404);
    if (!episode.activeTranscriptRevisionId) return json({ error: "an active transcript is required" }, 409);
    if (listCandidates(episodeId).length) return json({ error: "candidate set already exists" }, 409);
    return json({ candidates: generateFixtureCandidates(episodeId, session.pubkey), episode: getEpisode(episodeId) }, 201);
  }

  const approvedCandidateOrderMatch = pathname.match(/^\/api\/episodes\/([^/]+)\/approved-candidate-order$/);
  if (approvedCandidateOrderMatch && req.method === "PUT") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const episodeId = decodeURIComponent(approvedCandidateOrderMatch[1]!);
    if (!getEpisode(episodeId)) return json({ error: "episode not found" }, 404);
    const body = await readJson(req);
    if (!Array.isArray(body.candidateIds)) return json({ error: "candidateIds must be an array" }, 400);
    try {
      const candidates = setApprovedCandidateOrder(episodeId, body.candidateIds.map(String), session.pubkey);
      return json({ candidates, generations: buildCandidateGenerations(candidates, listEpisodePipelineRequests(episodeId)), approvedBatch: validateApprovedCandidateBatch(episodeId), episode: getEpisode(episodeId) });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  const approveCandidateBatchMatch = pathname.match(/^\/api\/episodes\/([^/]+)\/approved-candidate-batch$/);
  if (approveCandidateBatchMatch && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const episodeId = decodeURIComponent(approveCandidateBatchMatch[1]!);
    if (!getEpisode(episodeId)) return json({ error: "episode not found" }, 404);
    try {
      return json({ approvedBatch: approveCandidateBatch(episodeId, session.pubkey), episode: getEpisode(episodeId) });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error), approvedBatch: validateApprovedCandidateBatch(episodeId) }, 409);
    }
  }

  const episodePipelineRequestsMatch = pathname.match(/^\/api\/episodes\/([^/]+)\/pipeline-requests$/);
  if (episodePipelineRequestsMatch && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasAccess(session.pubkey, "read")) return json({ error: "read access required" }, 403);
    const episodeId = decodeURIComponent(episodePipelineRequestsMatch[1]!);
    const episode = getEpisode(episodeId);
    if (!episode) return json({ error: "episode not found" }, 404);
    markStalePipelineRunsTimedOut({ episodeId, timeoutMs: PIPELINE_TIMEOUT_MS });
    return json({
      timeoutMs: PIPELINE_TIMEOUT_MS,
      pipelineRequests: listEpisodePipelineRequests(episodeId).map((request) => ({
        ...request,
        staleInput: request.inputTranscriptRevisionId !== episode.activeTranscriptRevisionId,
      })),
    });
  }

  if (episodePipelineRequestsMatch && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const episodeId = decodeURIComponent(episodePipelineRequestsMatch[1]!);
    const episode = getEpisode(episodeId);
    if (!episode) return json({ error: "episode not found" }, 404);
    const transcript = getActiveTranscriptRevision(episodeId);
    if (!transcript) return json({ error: "an active transcript revision is required" }, 409);
    const body = await readJson(req);
    const operation = String(body.operation || "transcript-to-snacks") as PipelineOperation;
    if (!PIPELINE_OPERATIONS.includes(operation)) return json({ error: "unsupported pipeline operation" }, 400);
    const target = getRequestedAutopilotTarget(body.autopilotTargetId);
    const pipelineName = normalizePipelineName(body.pipelineName) || target.defaultPipeline;
    const pipelineRequest = createPipelineRequest({
      episodeId,
      operation,
      actorPubkey: session.pubkey,
      transcriptRevisionId: transcript.id,
      autopilotTargetId: target.id,
      pipelineName,
      pipelineVersion: typeof body.pipelineVersion === "string" ? body.pipelineVersion.trim() || null : null,
      promptSuiteVersion: typeof body.promptSuiteVersion === "string" ? body.promptSuiteVersion.trim() || undefined : undefined,
      resultSchemaVersion: typeof body.resultSchemaVersion === "string" ? body.resultSchemaVersion.trim() || undefined : undefined,
      idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() || undefined : undefined,
      targetCandidateId: typeof body.targetCandidateId === "string" ? body.targetCandidateId.trim() || null : null,
      regenerationInstruction: typeof body.regenerationInstruction === "string" ? body.regenerationInstruction.trim() || null : null,
    });
    recordAuditEvent({
      actorPubkey: session.pubkey,
      action: "pipeline.request.created",
      entityType: "episode",
      entityId: episodeId,
      detail: {
        requestId: pipelineRequest.id,
        operation: pipelineRequest.operation,
        transcriptRevisionId: pipelineRequest.inputTranscriptRevisionId,
        transcriptSha256: pipelineRequest.inputTranscriptSha256,
        pipelineName: pipelineRequest.pipelineName,
        promptSuiteVersion: pipelineRequest.promptSuiteVersion,
      },
    });
    const prepared = prepareEpisodePipelineRun(req, pipelineRequest, pubkeyToNpub(session.pubkey));
    return json({
      pipelineRequest: { ...getPipelineRequest(pipelineRequest.id), runs: [prepared.run] },
      runId: prepared.run.id,
      requiresAutopilotAuth: true,
      triggerRequest: prepared.triggerPayload,
    }, 201);
  }

  const episodePipelineRetryMatch = pathname.match(/^\/api\/pipeline-requests\/([^/]+)\/retry$/);
  if (episodePipelineRetryMatch && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const requestId = decodeURIComponent(episodePipelineRetryMatch[1]!);
    const pipelineRequest = getPipelineRequest(requestId);
    if (!pipelineRequest) return json({ error: "pipeline request not found" }, 404);
    if (pipelineRequest.status === "completed") return json({ error: "completed pipeline requests cannot be retried" }, 409);
    if (["queued", "running", "applying-result"].includes(pipelineRequest.status)) {
      return json({ error: `pipeline request cannot be retried from ${pipelineRequest.status}` }, 409);
    }
    const previousRun = listEpisodePipelineRequests(pipelineRequest.episodeId)
      .find((item) => item.id === requestId)?.runs[0] || null;
    cancelUnstartedPipelineRuns(requestId);
    let prepared;
    try {
      prepared = prepareEpisodePipelineRun(req, pipelineRequest, pubkeyToNpub(session.pubkey), previousRun?.id || null);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
    recordAuditEvent({
      actorPubkey: session.pubkey,
      action: "pipeline.request.retried",
      entityType: "episode",
      entityId: pipelineRequest.episodeId,
      detail: { requestId, runId: prepared.run.id, retryOfRunId: previousRun?.id || null, attemptNumber: prepared.run.attemptNumber },
    });
    return json({
      pipelineRequest: { ...getPipelineRequest(requestId), runs: listEpisodePipelineRequests(pipelineRequest.episodeId).find((item) => item.id === requestId)?.runs || [prepared.run] },
      runId: prepared.run.id,
      requiresAutopilotAuth: true,
      triggerRequest: prepared.triggerPayload,
    }, 201);
  }

  const episodePipelineStartMatch = pathname.match(/^\/api\/episode-pipeline-runs\/([^/]+)\/start$/);
  if (episodePipelineStartMatch && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const runId = decodeURIComponent(episodePipelineStartMatch[1]!);
    const run = getPipelineRun(runId);
    if (!run) return json({ error: "pipeline run not found" }, 404);
    const pipelineRequest = getPipelineRequest(run.requestId);
    if (!pipelineRequest) return json({ error: "pipeline request not found" }, 404);
    if (!["awaiting-authorization", "prepared"].includes(run.status)) {
      return json({ error: `pipeline run cannot start from ${run.status}` }, 409);
    }
    const body = await readJson(req);
    const autopilotAuthorization = String(body.autopilotAuthorization || "").trim();
    const triggerRequest = body.triggerRequest;
    if (!autopilotAuthorization) return json({ error: "autopilotAuthorization is required" }, 400);
    if (!triggerRequest || typeof triggerRequest !== "object" || Array.isArray(triggerRequest)) {
      return json({ error: "triggerRequest is required" }, 400);
    }
    if (!verifyPreparedPipelineTrigger(run.id, triggerRequest as Record<string, unknown>)) {
      return json({ error: "prepared pipeline trigger does not match this run" }, 409);
    }
    const triggerInput = (triggerRequest as EpisodePipelineTriggerRequest).body.input;
    if (triggerInput.attemptId !== run.id) return json({ error: "prepared pipeline attempt does not match this run" }, 409);
    try {
      const result = await startPreparedEpisodePipeline(triggerRequest as unknown as EpisodePipelineTriggerRequest, autopilotAuthorization);
      const updatedRun = markPipelineRunStarted({ runId: run.id, autopilotRunId: result.runId, remoteStatus: result.status });
      recordAuditEvent({
        actorPubkey: session.pubkey,
        action: "pipeline.run.started",
        entityType: "episode",
        entityId: pipelineRequest.episodeId,
        detail: { requestId: pipelineRequest.id, runId: run.id, autopilotRunId: result.runId, pipelineName: pipelineRequest.pipelineName },
      });
      return json({ pipelineRequest: { ...getPipelineRequest(pipelineRequest.id), runs: listEpisodePipelineRequests(pipelineRequest.episodeId).find((item) => item.id === pipelineRequest.id)?.runs || [updatedRun] } }, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedRun = markPipelineRunFailed({ runId: run.id, category: "trigger-failed", summary: message });
      recordAuditEvent({
        actorPubkey: session.pubkey,
        action: "pipeline.run.failed",
        entityType: "episode",
        entityId: pipelineRequest.episodeId,
        detail: { requestId: pipelineRequest.id, runId: run.id, category: "trigger-failed", summary: message.slice(0, 500) },
      });
      return json({ error: message, pipelineRequest: { ...getPipelineRequest(pipelineRequest.id), runs: [failedRun] } }, 502);
    }
  }

  const candidateMatch = pathname.match(/^\/api\/candidates\/([^/]+)$/);
  if (candidateMatch && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasAccess(session.pubkey, "read")) return json({ error: "read access required" }, 403);
    const candidate = getCandidate(decodeURIComponent(candidateMatch[1]!));
    return candidate ? json({ candidate }) : json({ error: "candidate not found" }, 404);
  }

  if (candidateMatch && req.method === "PATCH") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const candidateId = decodeURIComponent(candidateMatch[1]!);
    const body = await readJson(req);
    if (body.reviewDecision !== undefined) {
      const decision = validateReviewDecision(body.reviewDecision);
      if (!decision) return json({ error: "invalid reviewDecision" }, 400);
      const candidate = updateCandidateDecision(candidateId, decision, session.pubkey);
      return candidate ? json({ candidate }) : json({ error: "candidate not found" }, 404);
    }
    const validated = validateCandidateRevision(body);
    if (!validated.ok) return json({ error: validated.error }, 400);
    const candidate = createCandidateRevision(candidateId, validated.value, session.pubkey);
    return candidate ? json({ candidate }, 201) : json({ error: "candidate not found" }, 404);
  }

  const activateCandidateRevisionMatch = pathname.match(/^\/api\/candidates\/([^/]+)\/revisions\/([^/]+)\/active$/);
  if (activateCandidateRevisionMatch && req.method === "PUT") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const candidate = activateCandidateRevision(
      decodeURIComponent(activateCandidateRevisionMatch[1]!),
      decodeURIComponent(activateCandidateRevisionMatch[2]!),
      session.pubkey,
    );
    return candidate ? json({ candidate }) : json({ error: "candidate revision not found" }, 404);
  }

  const regenerationProposalMatch = pathname.match(/^\/api\/regeneration-proposals\/([^/]+)\/(adopt|discard)$/);
  if (regenerationProposalMatch && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    try {
      const proposalId = decodeURIComponent(regenerationProposalMatch[1]!);
      const resolution = regenerationProposalMatch[2] === "adopt" ? "adopted" : "discarded";
      const candidate = resolveRegenerationProposal(proposalId, resolution, session.pubkey);
      if (!candidate) return json({ error: "regeneration proposal not found" }, 404);
      return json({ candidate, proposals: listRegenerationProposals(candidate.id), episode: getEpisode(candidate.episodeId) });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  }

  const curationMatch = pathname.match(/^\/api\/episodes\/([^/]+)\/curation$/);
  if (curationMatch && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasAccess(session.pubkey, "read")) return json({ error: "read access required" }, 403);
    const episodeId = decodeURIComponent(curationMatch[1]!);
    if (!getEpisode(episodeId)) return json({ error: "episode not found" }, 404);
    return json(getCuration(episodeId));
  }

  const newsletterMatch = pathname.match(/^\/api\/episodes\/([^/]+)\/newsletter-items$/);
  if (newsletterMatch && req.method === "PUT") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const episodeId = decodeURIComponent(newsletterMatch[1]!);
    if (!getEpisode(episodeId)) return json({ error: "episode not found" }, 404);
    const body = await readJson(req);
    if (!Array.isArray(body.candidateIds)) return json({ error: "candidateIds must be an array" }, 400);
    try {
      return json({ newsletterItems: setNewsletterItems(episodeId, body.candidateIds.map(String), session.pubkey), validation: getCuration(episodeId).validation });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  const fixtureRelationshipsMatch = pathname.match(/^\/api\/episodes\/([^/]+)\/fixture-relationships$/);
  if (fixtureRelationshipsMatch && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const episodeId = decodeURIComponent(fixtureRelationshipsMatch[1]!);
    try {
      return json({ relationships: createFixtureRelationshipSuggestions(episodeId, session.pubkey), validation: getCuration(episodeId).validation }, 201);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  if (pathname === "/api/relationships" && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const relationshipType = typeof body.relationshipType === "string" && RELATIONSHIP_TYPES.includes(body.relationshipType as never) ? body.relationshipType as typeof RELATIONSHIP_TYPES[number] : null;
    if (!relationshipType) return json({ error: "invalid relationshipType" }, 400);
    try {
      const relationship = createRelationship({
        episodeId: String(body.episodeId || ""), sourceCandidateId: String(body.sourceCandidateId || ""),
        targetCandidateId: String(body.targetCandidateId || ""), relationshipType,
        explanation: typeof body.explanation === "string" && body.explanation.trim() ? body.explanation.trim().slice(0, 1000) : null,
        origin: "manual", reviewState: "approved", actorPubkey: session.pubkey,
      });
      return json({ relationship }, 201);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  const relationshipMatch = pathname.match(/^\/api\/relationships\/([^/]+)$/);
  if (relationshipMatch && req.method === "PATCH") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const state = ["draft", "approved", "rejected"].includes(String(body.reviewState)) ? String(body.reviewState) as "draft" | "approved" | "rejected" : null;
    if (!state) return json({ error: "invalid reviewState" }, 400);
    const relationship = updateRelationshipState(decodeURIComponent(relationshipMatch[1]!), state, session.pubkey);
    return relationship ? json({ relationship }) : json({ error: "relationship not found" }, 404);
  }

  if (relationshipMatch && req.method === "DELETE") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    return deleteRelationship(decodeURIComponent(relationshipMatch[1]!), session.pubkey) ? json({ ok: true }) : json({ error: "relationship not found" }, 404);
  }

  if (pathname === "/api/autopilot-targets" && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : "New Autopilot";
    const url = normalizeAutopilotUrl(body.url);
    const defaultPipeline = normalizePipelineName(body.defaultPipeline);
    if (!url) return json({ error: "url must be a valid http(s) URL" }, 400);
    if (!defaultPipeline) return json({ error: "defaultPipeline is required" }, 400);
    const target = upsertAutopilotTarget({ label, url, defaultPipeline });
    setSetting("currentAutopilotTargetId", target.id);
    recordAuditEvent({
      actorPubkey: session.pubkey,
      action: "settings.autopilot.created",
      entityType: "autopilot-target",
      entityId: target.id,
      detail: { label: target.label, defaultPipeline: target.defaultPipeline },
    });
    return json({ target, settings: getAppSettings() }, 201);
  }

  const autopilotTargetMatch = pathname.match(/^\/api\/autopilot-targets\/([^/]+)$/);
  if (autopilotTargetMatch && req.method === "DELETE") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const id = decodeURIComponent(autopilotTargetMatch[1]!);
    if (listAutopilotTargets().length <= 1) return json({ error: "at least one Autopilot target is required" }, 409);
    deleteAutopilotTarget(id);
    recordAuditEvent({
      actorPubkey: session.pubkey,
      action: "settings.autopilot.deleted",
      entityType: "autopilot-target",
      entityId: id,
    });
    return json({ ok: true, settings: getAppSettings() });
  }

  if (pathname === "/api/autopilot-targets/current" && req.method === "PUT") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const body = await readJson(req);
    const targetId = typeof body.autopilotTargetId === "string" ? body.autopilotTargetId.trim() : "";
    const target = getAutopilotTarget(targetId);
    if (!target) return json({ error: "Autopilot target not found" }, 404);
    setSetting("currentAutopilotTargetId", target.id);
    return json({ settings: getAppSettings() });
  }

  if (pathname === "/api/access-rules" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    return json({ accessRules: getAccessRules() });
  }

  if (pathname === "/api/access-rules" && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const pubkey = normalizePubkey(String(body.npub ?? body.pubkey ?? ""));
    const role = normalizeAccessRole(body.role);
    if (!pubkey) return json({ error: "npub or pubkey is required" }, 400);
    if (!role) return json({ error: "role must be read or edit" }, 400);
    const accessRule = addAccessRule(pubkey, role);
    recordAuditEvent({
      actorPubkey: session.pubkey,
      action: "access.granted",
      entityType: "access-rule",
      entityId: `${pubkey}:${role}`,
      detail: { pubkey, role },
    });
    return json({ accessRule, accessRules: getAccessRules() }, 201);
  }

  const accessRuleMatch = pathname.match(/^\/api\/access-rules\/(read|edit)\/([^/]+)$/);
  if (accessRuleMatch && req.method === "DELETE") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const role = normalizeAccessRole(accessRuleMatch[1]);
    const pubkey = normalizePubkey(decodeURIComponent(accessRuleMatch[2]!));
    if (!role || !pubkey) return json({ error: "valid role and npub/pubkey are required" }, 400);
    removeAccessRule(pubkey, role);
    recordAuditEvent({
      actorPubkey: session.pubkey,
      action: "access.revoked",
      entityType: "access-rule",
      entityId: `${pubkey}:${role}`,
      detail: { pubkey, role },
    });
    return json({ ok: true, accessRules: getAccessRules() });
  }

  if (pathname === "/api/autopilot/pipelines-request" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const target = getRequestedAutopilotTarget(url.searchParams.get("autopilotTargetId"));
    return json({ triggerRequest: buildAutopilotPipelinesRequest(target), settings: getAppSettings(), target });
  }

  if (pathname === "/api/autopilot/pipelines" && req.method === "POST") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const body = await readJson(req);
    const target = getRequestedAutopilotTarget(body.autopilotTargetId);
    const request = buildAutopilotPipelinesRequest(target);
    const autopilotAuthorization = String(body.autopilotAuthorization ?? "").trim();
    if (!autopilotAuthorization) {
      return json({ requiresAutopilotAuth: true, triggerRequest: request, settings: getAppSettings(), target }, 202);
    }
    const res = await fetch(request.url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: autopilotAuthorization,
      },
    });
    const payload = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) return json({ error: String(payload.error ?? res.statusText), status: res.status }, 502);
    return json({ pipelines: payload.definitions ?? [], raw: payload, target });
  }

  if (pathname === "/api/db/status" && req.method === "GET") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    return json(getDbStatus());
  }

  if (pathname === "/api/db/snapshots" && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const snapshot = exportSnapshot(String(body.note ?? ""));
    recordAuditEvent({
      actorPubkey: session.pubkey,
      action: "database.snapshot.exported",
      entityType: "database-snapshot",
      entityId: snapshot.id,
      detail: { filename: snapshot.filename },
    });
    return json({ snapshot, status: getDbStatus() }, 201);
  }

  const snapshotDownloadMatch = pathname.match(/^\/api\/db\/snapshots\/([^/]+)\/download$/);
  if (snapshotDownloadMatch && req.method === "GET") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const filename = decodeURIComponent(snapshotDownloadMatch[1]!);
    const path = snapshotPath(filename);
    if (!path) return json({ error: "snapshot not found" }, 404);
    return new Response(Bun.file(path), {
      headers: {
        "content-type": "application/vnd.sqlite3",
        "content-disposition": `attachment; filename="${filename.replaceAll('"', "")}"`,
        "cache-control": "no-store",
      },
    });
  }

  if (pathname === "/api/db/import" && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return json({ error: "file is required" }, 400);
      return json({ import: await stageUploadedImport(file), status: getDbStatus() }, 202);
    }
    const body = await readJson(req);
    const filename = String(body.filename ?? "");
    if (!filename) return json({ error: "filename is required" }, 400);
    return json({ import: stageSnapshotImport(filename), status: getDbStatus() }, 202);
  }

  if (pathname === "/api/db/import" && req.method === "DELETE") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    clearPendingImport();
    return json({ ok: true, status: getDbStatus() });
  }

  if (pathname === "/api/chats" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const rows = db.query(`
      SELECT c.*, (
        SELECT content FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1
      ) AS preview
      FROM chats c
      WHERE c.pubkey = ?1
      ORDER BY c.updated_at DESC
    `).all(session.pubkey) as Record<string, unknown>[];
    return json({ chats: rows.map((row) => ({ ...mapChat(row), preview: String(row.preview ?? "") })) });
  }

  if (pathname === "/api/chats" && req.method === "POST") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const now = Date.now();
    const id = crypto.randomUUID();
    db.query("INSERT INTO chats(id, pubkey, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)")
      .run(id, session.pubkey, "New chat", now);
    return json({ chat: getChatForUser(id, session.pubkey) }, 201);
  }

  const chatMessagesMatch = pathname.match(/^\/api\/chats\/([^/]+)\/messages$/);
  if (chatMessagesMatch && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const chatId = decodeURIComponent(chatMessagesMatch[1]!);
    const chat = getChatForUser(chatId, session.pubkey);
    if (!chat) return json({ error: "chat not found" }, 404);
    return json({ chat, messages: listMessages(chatId, session.pubkey) });
  }

  if (chatMessagesMatch && req.method === "POST") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const chatId = decodeURIComponent(chatMessagesMatch[1]!);
    const chat = getChatForUser(chatId, session.pubkey);
    if (!chat) return json({ error: "chat not found" }, 404);
    const body = await readJson(req);
    const content = String(body.content ?? "").trim();
    if (!content) return json({ error: "content is required" }, 400);
    if (content.length > 12000) return json({ error: "content is too long" }, 400);
    const autopilotTarget = getRequestedAutopilotTarget(body.autopilotTargetId);
    const pipelineName = normalizePipelineName(body.pipelineName) || autopilotTarget.defaultPipeline;

    const now = Date.now();
    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const localRunId = crypto.randomUUID();
    const webhookToken = crypto.randomUUID().replaceAll("-", "");
    db.query("INSERT INTO messages(id, chat_id, pubkey, role, content, status, run_id, created_at) VALUES (?1, ?2, ?3, 'user', ?4, 'complete', ?5, ?6)")
      .run(userMessageId, chatId, session.pubkey, content, localRunId, now);
    db.query("INSERT INTO messages(id, chat_id, pubkey, role, content, status, run_id, created_at) VALUES (?1, ?2, ?3, 'assistant', '', 'pending', ?4, ?5)")
      .run(assistantMessageId, chatId, session.pubkey, localRunId, now + 1);
    if (chat.title === "New chat") updateChatTitle(chatId, content.replace(/\s+/g, " ").slice(0, 64));
    db.query("UPDATE chats SET updated_at = ?1 WHERE id = ?2").run(now, chatId);

    const history = listMessages(chatId, session.pubkey)
      .filter((msg) => msg.status === "complete" && (msg.role === "user" || msg.role === "assistant"))
      .slice(-30)
      .map((msg) => ({ role: msg.role, content: msg.content, createdAt: msg.createdAt }));

    const webhookUrl = `${webhookOrigin(req)}/api/pipeline-webhook`;
    const settings = getAppSettings();
    const triggerRequest = buildPipelineTriggerRequest({
      chatId,
      userPubkey: session.pubkey,
      userNpub: pubkeyToNpub(session.pubkey),
      message: content,
      history,
      webhookUrl,
      webhookToken,
      autopilotTargetId: autopilotTarget.id,
      autopilotLabel: autopilotTarget.label,
      autopilotUrl: resolveAutopilotServerUrl(autopilotTarget.url || settings.autopilotUrl),
      pipelineName,
    });
    db.query(`
      INSERT INTO chat_pipeline_runs(
        id,
        chat_id,
        user_message_id,
        assistant_message_id,
        trigger_status,
        webhook_token,
        trigger_payload_json,
        autopilot_target_id,
        autopilot_url,
        pipeline_name,
        created_at,
        updated_at
      )
      VALUES (?1, ?2, ?3, ?4, 'awaiting-user-nip98', ?5, ?6, ?7, ?8, ?9, ?10, ?10)
    `).run(
      localRunId,
      chatId,
      userMessageId,
      assistantMessageId,
      webhookToken,
      JSON.stringify(triggerRequest),
      autopilotTarget.id,
      autopilotTarget.url,
      pipelineName,
      now,
    );

    const autopilotAuthorization = typeof body.autopilotAuthorization === "string" ? body.autopilotAuthorization.trim() : "";
    if (!autopilotAuthorization) {
      return json({
        requiresAutopilotAuth: true,
        triggerRequest,
        messages: listMessages(chatId, session.pubkey),
        runId: localRunId,
      }, 202);
    }

    try {
      const result = await startPreparedChatPipeline(triggerRequest, autopilotAuthorization);
      db.query("UPDATE chat_pipeline_runs SET trigger_status = ?1, autopilot_run_id = ?2, updated_at = ?3 WHERE id = ?4")
        .run(result.mode, result.runId, Date.now(), localRunId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.query("UPDATE messages SET status = 'error', content = ?1 WHERE id = ?2").run(message, assistantMessageId);
      db.query("UPDATE chat_pipeline_runs SET trigger_status = 'error', error = ?1, updated_at = ?2 WHERE id = ?3")
        .run(message, Date.now(), localRunId);
    }

    return json({ messages: listMessages(chatId, session.pubkey), runId: localRunId }, 202);
  }

  const pipelineStartMatch = pathname.match(/^\/api\/pipeline-runs\/([^/]+)\/start$/);
  if (pipelineStartMatch && req.method === "POST") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const runId = decodeURIComponent(pipelineStartMatch[1]!);
    const body = await readJson(req);
    const autopilotAuthorization = String(body.autopilotAuthorization ?? "").trim();
    if (!autopilotAuthorization) return json({ error: "autopilotAuthorization is required" }, 400);
    const run = db.query(`
      SELECT pr.*, c.pubkey
      FROM chat_pipeline_runs pr
      JOIN chats c ON c.id = pr.chat_id
      WHERE pr.id = ?1 AND c.pubkey = ?2
    `).get(runId, session.pubkey) as Record<string, unknown> | null;
    if (!run) return json({ error: "pipeline run not found" }, 404);
    if (String(run.trigger_status) === "complete") {
      return json({ messages: listMessages(String(run.chat_id), session.pubkey), runId });
    }
    const rawTrigger = String(run.trigger_payload_json ?? "");
    if (!rawTrigger) return json({ error: "pipeline trigger payload missing" }, 409);
    let triggerRequest: PipelineTriggerRequest;
    try {
      triggerRequest = JSON.parse(rawTrigger) as PipelineTriggerRequest;
    } catch {
      return json({ error: "pipeline trigger payload is invalid" }, 409);
    }
    try {
      const result = await startPreparedChatPipeline(triggerRequest, autopilotAuthorization);
      db.query("UPDATE chat_pipeline_runs SET trigger_status = ?1, autopilot_run_id = ?2, updated_at = ?3 WHERE id = ?4")
        .run(result.mode, result.runId, Date.now(), runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.query("UPDATE messages SET status = 'error', content = ?1 WHERE id = ?2").run(message, String(run.assistant_message_id));
      db.query("UPDATE chat_pipeline_runs SET trigger_status = 'error', error = ?1, updated_at = ?2 WHERE id = ?3")
        .run(message, Date.now(), runId);
    }
    return json({ messages: listMessages(String(run.chat_id), session.pubkey), runId });
  }

  if (pathname === "/api/pipeline-webhook" && req.method === "POST") {
    const body = await readJson(req);
    const token = req.headers.get("x-snack-studio-token") || req.headers.get("x-chat-wapp-token") || String(body.token ?? "");
    const requestId = String(body.requestId ?? "").trim();
    if (requestId) {
      const callbackToken = req.headers.get("x-snack-studio-token") || "";
      if (!callbackToken) return json({ error: "x-snack-studio-token is required" }, 401);
      const run = findPipelineRunForCallback(requestId, callbackToken);
      if (!run) return json({ error: "pipeline callback credential is invalid" }, 401);
      const pipelineRequest = getPipelineRequest(requestId);
      if (!pipelineRequest) return json({ error: "pipeline request not found" }, 404);
      if (pipelineRequest.status === "completed" && pipelineRequest.resultAppliedAt) {
        const count = db.query("SELECT COUNT(*) AS count FROM snack_candidates WHERE pipeline_request_id = ?1").get(requestId) as { count: number };
        return json({ ok: true, requestId, status: "completed", replay: true, candidateCount: Number(count.count) });
      }

      if (body.status === "progress") {
        const attemptId = String(body.attemptId || "").trim();
        if (attemptId !== run.id) return json({ error: "pipeline progress attempt mismatch" }, 409);
        const updated = updatePipelineRunProgress({
          runId: run.id,
          percent: Number(body.percent || 0),
          label: String(body.label || "Autopilot is working"),
        });
        return json({ ok: true, requestId, status: "running", progressPercent: updated.progressPercent });
      }

      if (body.status === "error" || body.status === "failed") {
        const remoteRunId = String(body.runId || "").trim();
        if (run.autopilotRunId && remoteRunId && run.autopilotRunId !== remoteRunId) {
          return json({ error: "pipeline callback Autopilot run mismatch" }, 409);
        }
        const failure = String(body.error || body.message || "Autopilot pipeline failed").trim().slice(0, 1000);
        markPipelineRunFailed({ runId: run.id, category: "pipeline-failed", summary: failure });
        recordAuditEvent({
          action: "pipeline.callback.failed",
          entityType: "episode",
          entityId: pipelineRequest.episodeId,
          detail: { requestId, runId: run.id, autopilotRunId: remoteRunId || run.autopilotRunId, summary: failure.slice(0, 500) },
        });
        return json({ ok: true, requestId, status: "failed" });
      }

      const validation = pipelineRequest.operation === "snack-regeneration"
        ? validateSuccessfulRegenerationResult(body)
        : pipelineRequest.operation === "publication-metadata"
          ? validateSuccessfulPublicationMetadataResult(body)
          : validateSuccessfulPipelineResult(body);
      if (!validation.ok) {
        markPipelineResultRejected({ runId: run.id, summary: validation.error });
        recordAuditEvent({
          action: "pipeline.callback.rejected",
          entityType: "episode",
          entityId: pipelineRequest.episodeId,
          detail: { requestId, runId: run.id, reason: validation.error },
        });
        return json({ error: validation.error, requestId, status: "needs-review" }, 422);
      }
      try {
        if (validation.value.attemptId !== run.id) return json({ error: "pipeline callback attempt mismatch" }, 409);
        if (pipelineRequest.operation === "snack-regeneration") {
          const proposal = applySuccessfulRegenerationResult({ localRunId: run.id, result: validation.value as import("./regeneration-result-input.ts").SuccessfulRegenerationResult });
          recordAuditEvent({ action: "candidate.regeneration.proposed", entityType: "episode", entityId: pipelineRequest.episodeId, detail: { requestId, runId: run.id, candidateId: proposal.candidateId, proposalId: proposal.id } });
          return json({ ok: true, requestId, status: "completed", proposalId: proposal.id });
        }
        if (pipelineRequest.operation === "publication-metadata") {
          const applied = applySuccessfulPublicationMetadataResult({ localRunId: run.id, result: validation.value as import("./publication-metadata-result-input.ts").SuccessfulPublicationMetadataResult });
          recordAuditEvent({ action: "publication.topics.assigned", entityType: "episode", entityId: pipelineRequest.episodeId, detail: { requestId, runId: run.id, assignmentCount: applied.assignmentCount } });
          return json({ ok: true, requestId, status: "completed", replay: applied.replay, assignmentCount: applied.assignmentCount });
        }
        const successfulResult = validation.value as import("./pipeline-result-input.ts").SuccessfulPipelineResult;
        const applied = applySuccessfulPipelineResult({ localRunId: run.id, result: successfulResult });
        if (!applied.replay) {
          recordAuditEvent({
            action: "pipeline.callback.applied",
            entityType: "episode",
            entityId: pipelineRequest.episodeId,
            detail: {
              requestId,
              runId: run.id,
              autopilotRunId: successfulResult.runId,
              candidateCount: applied.candidateCount,
              promptSuiteVersion: successfulResult.promptSuiteVersion,
              pipelineVersion: successfulResult.pipelineVersion,
              resultSchemaVersion: successfulResult.resultSchemaVersion,
            },
          });
        }
        return json({ ok: true, requestId, status: "completed", replay: applied.replay, candidateCount: applied.candidateCount });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        markPipelineResultRejected({ runId: run.id, summary: message });
        return json({ error: message, requestId, status: "needs-review" }, 409);
      }
    }
    const chatId = String(body.chatId ?? "");
    const response = String(body.response ?? body.message ?? "").trim();
    const runId = String(body.runId ?? "");
    if (!chatId || !token || !response) return json({ error: "chatId, token, and response are required" }, 400);
    const run = db.query("SELECT * FROM chat_pipeline_runs WHERE chat_id = ?1 AND webhook_token = ?2 ORDER BY created_at DESC LIMIT 1")
      .get(chatId, token) as Record<string, unknown> | null;
    if (!run) return json({ error: "webhook target not found" }, 404);
    const now = Date.now();
    db.query("UPDATE messages SET content = ?1, status = 'complete', run_id = ?2 WHERE id = ?3")
      .run(response, runId || String(run.id), String(run.assistant_message_id));
    db.query("UPDATE chat_pipeline_runs SET trigger_status = 'complete', autopilot_run_id = COALESCE(?1, autopilot_run_id), updated_at = ?2 WHERE id = ?3")
      .run(runId || null, now, String(run.id));
    db.query("UPDATE chats SET updated_at = ?1 WHERE id = ?2").run(now, chatId);
    return json({ ok: true });
  }

  if (pathname === "/api/nip98/me" && req.method === "GET") {
    const verified = await verifyNip98Request(req, url);
    if (!verified.ok) return json({ error: verified.error }, 401);
    return json({
      pubkey: verified.pubkey,
      npub: verified.npub,
      access: {
        login: canLogin(verified.pubkey),
        read: hasAccess(verified.pubkey, "read"),
        edit: hasAccess(verified.pubkey, "edit"),
      },
    });
  }

  const nip98PipelineContextMatch = pathname.match(/^\/api\/nip98\/pipeline-requests\/([^/]+)\/context$/);
  if (nip98PipelineContextMatch && req.method === "GET") {
    const verified = await verifyNip98Request(req, url);
    if (!verified.ok) return json({ error: verified.error }, 401);
    if (!hasAccess(verified.pubkey, "read")) return json({ error: "read access required" }, 403);
    const requestId = decodeURIComponent(nip98PipelineContextMatch[1]!);
    const context = getPipelineRequestContext(requestId);
    if (!context) return json({ error: "pipeline request not found" }, 404);
    const transcriptUrl = new URL(`/api/nip98/pipeline-requests/${encodeURIComponent(requestId)}/transcript`, url.origin).toString();
    return json({
      ...context,
      transcript: { ...context.transcript, contentUrl: transcriptUrl },
    });
  }

  const nip98PipelineTranscriptMatch = pathname.match(/^\/api\/nip98\/pipeline-requests\/([^/]+)\/transcript$/);
  if (nip98PipelineTranscriptMatch && req.method === "GET") {
    const verified = await verifyNip98Request(req, url);
    if (!verified.ok) return json({ error: verified.error }, 401);
    if (!hasAccess(verified.pubkey, "read")) return json({ error: "read access required" }, 403);
    const requestId = decodeURIComponent(nip98PipelineTranscriptMatch[1]!);
    const transcript = getPipelineRequestTranscript(requestId);
    if (!transcript) return json({ error: "pipeline request not found" }, 404);
    return json({ transcript });
  }

  if (pathname === "/api/nip98/chats" && req.method === "GET") {
    const verified = await verifyNip98Request(req, url);
    if (!verified.ok) return json({ error: verified.error }, 401);
    if (!hasAccess(verified.pubkey, "read")) return json({ error: "read access required" }, 403);
    const rows = db.query(`
      SELECT c.*, u.npub, (
        SELECT content FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1
      ) AS preview
      FROM chats c
      JOIN users u ON u.pubkey = c.pubkey
      ORDER BY c.updated_at DESC
      LIMIT 200
    `).all() as Record<string, unknown>[];
    return json({ chats: rows.map((row) => ({ ...mapChat(row), npub: String(row.npub), preview: String(row.preview ?? "") })) });
  }

  const nip98ChatMessagesMatch = pathname.match(/^\/api\/nip98\/chats\/([^/]+)\/messages$/);
  if (nip98ChatMessagesMatch && req.method === "GET") {
    const verified = await verifyNip98Request(req, url);
    if (!verified.ok) return json({ error: verified.error }, 401);
    if (!hasAccess(verified.pubkey, "read")) return json({ error: "read access required" }, 403);
    const chatId = decodeURIComponent(nip98ChatMessagesMatch[1]!);
    const chat = db.query("SELECT c.*, u.npub FROM chats c JOIN users u ON u.pubkey = c.pubkey WHERE c.id = ?1").get(chatId) as Record<string, unknown> | null;
    if (!chat) return json({ error: "chat not found" }, 404);
    const rows = db.query("SELECT * FROM messages WHERE chat_id = ?1 ORDER BY created_at ASC").all(chatId) as Record<string, unknown>[];
    return json({ chat: { ...mapChat(chat), npub: String(chat.npub) }, messages: rows.map(mapMessage) });
  }

  if (nip98ChatMessagesMatch && req.method === "POST") {
    const verified = await verifyNip98Request(req, url);
    if (!verified.ok) return json({ error: verified.error }, 401);
    if (!hasAccess(verified.pubkey, "edit")) return json({ error: "edit access required" }, 403);
    const chatId = decodeURIComponent(nip98ChatMessagesMatch[1]!);
    const chat = db.query("SELECT * FROM chats WHERE id = ?1").get(chatId) as Record<string, unknown> | null;
    if (!chat) return json({ error: "chat not found" }, 404);
    const body = await readJson(req);
    const role = ["assistant", "system", "user"].includes(String(body.role)) ? String(body.role) : "system";
    const content = String(body.content ?? "").trim();
    if (!content) return json({ error: "content is required" }, 400);
    const now = Date.now();
    const id = crypto.randomUUID();
    db.query("INSERT INTO messages(id, chat_id, pubkey, role, content, status, run_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'complete', ?6, ?7)")
      .run(id, chatId, String(chat.pubkey), role, content, String(body.runId ?? ""), now);
    db.query("UPDATE chats SET updated_at = ?1 WHERE id = ?2").run(now, chatId);
    return json({ message: mapMessage(db.query("SELECT * FROM messages WHERE id = ?1").get(id) as Record<string, unknown>) }, 201);
  }

  const nip98ChatMatch = pathname.match(/^\/api\/nip98\/chats\/([^/]+)$/);
  if (nip98ChatMatch && req.method === "PATCH") {
    const verified = await verifyNip98Request(req, url);
    if (!verified.ok) return json({ error: verified.error }, 401);
    if (!hasAccess(verified.pubkey, "edit")) return json({ error: "edit access required" }, 403);
    const chatId = decodeURIComponent(nip98ChatMatch[1]!);
    const body = await readJson(req);
    const title = String(body.title ?? "").trim();
    if (!title) return json({ error: "title is required" }, 400);
    updateChatTitle(chatId, title);
    const row = db.query("SELECT * FROM chats WHERE id = ?1").get(chatId) as Record<string, unknown> | null;
    if (!row) return json({ error: "chat not found" }, 404);
    return json({ chat: mapChat(row) });
  }

  return null;
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      const response = await handleApi(req, url);
      if (response) return response;
      return json({ error: "not found" }, 404);
    }
    return serveStatic(url.pathname);
  },
});

console.log(`snack-studio listening on ${server.url}`);
