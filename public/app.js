import { derivePubkeyFromNsec, signEventWithNsec, signLoginChallengeWithNsec } from "/nostr-login.js";

const PROFILE_CACHE_KEY = "snack_studio_profiles_v1";
const PIPELINES_CACHE_KEY = "snack_studio_pipelines_v1";
const PROFILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CURRENT_SNACK_PROMPT_SUITE = "v3-intelligence-snacks-natural-prose";
const CURRENT_SNACK_PIPELINE_VERSION = "3";
const PROFILE_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
];

const state = {
  token: localStorage.getItem("snack_studio_token") || localStorage.getItem("chat_wapp_token") || "",
  me: null,
  chats: [],
  settings: null,
  accessRules: [],
  dbStatus: null,
  pipelines: loadPipelinesCache(),
  activeChatId: localStorage.getItem("snack_studio_chat") || localStorage.getItem("chat_wapp_chat") || "",
  activeAutopilotTargetId: localStorage.getItem("snack_studio_autopilot_target") || localStorage.getItem("chat_wapp_autopilot_target") || "",
  activePipelineName: localStorage.getItem("snack_studio_pipeline") || localStorage.getItem("chat_wapp_pipeline") || "",
  pollTimer: null,
  route: window.location.pathname,
  profiles: loadProfileCache(),
  directNsec: "",
  episodes: [],
  activeEpisode: null,
  activeTranscript: null,
  transcriptRevisions: [],
  candidates: [],
  candidateGenerations: [],
  approvedBatch: { ready: false, checks: [], candidateIds: [] },
  regenerationProposals: {},
  activeGenerationId: "",
  activeCandidateId: "",
  curation: { newsletterItems: [], relationships: [], validation: { ready: false, checks: [], counts: {} } },
  pipelineRequests: [],
  pipelineTimeoutMs: 0,
  episodeStage: "",
  episodeStageId: "",
  episodeAuditEvents: [],
  publicationPreparation: null,
};

const $ = (id) => document.getElementById(id);

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {}),
    },
  }).then(async (res) => {
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || res.statusText);
    return payload;
  });
}

function apiForm(path, formData) {
  return fetch(path, {
    method: "POST",
    headers: state.token ? { authorization: `Bearer ${state.token}` } : {},
    body: formData,
  }).then(async (res) => {
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || res.statusText);
    return payload;
  });
}

function hasCandidateGeneration(id) {
  return id === "approved" || state.candidateGenerations.some((generation) => generation.id === id);
}

function candidateGenerationId(candidate) {
  const provenanceId = candidate.pipelineRequestId || candidate.revision?.pipelineRequestId || candidate.revision?.pipelineRunId;
  if (provenanceId) return provenanceId;
  return candidate.revision?.origin === "fixture" ? "fixture" : "legacy";
}

function candidateGenerations(candidates, suppliedGenerations) {
  if (
    Array.isArray(suppliedGenerations)
    && suppliedGenerations.length
    && candidates.every((candidate) => suppliedGenerations.some((generation) => generation.id === candidateGenerationId(candidate)))
  ) return suppliedGenerations;
  const groups = new Map();
  for (const candidate of candidates) {
    const id = candidateGenerationId(candidate);
    const group = groups.get(id) || [];
    group.push(candidate);
    groups.set(id, group);
  }
  return [...groups.entries()]
    .map(([id, items]) => ({
      id,
      pipelineRequestId: id === "legacy" ? null : id,
      sequence: 0,
      createdAt: Math.min(...items.map((candidate) => Number(candidate.createdAt || 0))),
      candidateCount: items.length,
      acceptedCount: items.filter((candidate) => candidate.reviewDecision === "accepted").length,
      promptSuiteVersion: items[0]?.revision?.promptSuiteVersion || null,
      pipelineVersion: items[0]?.revision?.pipelineVersion || null,
      pipelineRunId: items[0]?.revision?.pipelineRunId || null,
    }))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((generation, index) => ({ ...generation, sequence: index + 1 }));
}

function setStatus(text) {
  $("status").textContent = text;
  if ($("studioStatus")) $("studioStatus").textContent = text;
}

function loadProfileCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function loadPipelinesCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PIPELINES_CACHE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePipelinesCache() {
  localStorage.setItem(PIPELINES_CACHE_KEY, JSON.stringify(state.pipelines));
}

function saveProfileCache() {
  localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(state.profiles));
}

function cachedProfile(pubkey) {
  const entry = state.profiles[pubkey];
  if (!entry || Date.now() - Number(entry.cachedAt || 0) > PROFILE_CACHE_TTL_MS) return null;
  return entry;
}

function profileFullName(profile) {
  const structuredName = [profile?.firstName, profile?.lastName].filter(Boolean).join(" ");
  return structuredName || profile?.displayName || profile?.name || "";
}

function displayNameForRule(rule, profile) {
  return profileFullName(profile) || `${rule.npub.slice(0, 12)}...${rule.npub.slice(-6)}`;
}

function profileInitial(rule, profile) {
  return displayNameForRule(rule, profile).slice(0, 1).toUpperCase();
}

function appRoute() {
  if (["/act", "/chat", "/settings"].includes(window.location.pathname)) return window.location.pathname;
  if (/^\/episodes\/[^/]+$/.test(window.location.pathname)) return window.location.pathname;
  return "/";
}

function navigate(path) {
  if (window.location.pathname !== path) history.pushState({}, "", path);
  state.route = path;
  void renderRoute();
}

function showOnly(id) {
  for (const sectionId of ["login", "home", "actPage", "shell"]) {
    $(sectionId).classList.toggle("hidden", sectionId !== id);
  }
}

function showStudioPage(id, breadcrumb) {
  for (const pageId of ["episodesPage", "episodePage", "studioSettingsPage"]) {
    $(pageId).classList.toggle("hidden", pageId !== id);
  }
  $("studioBreadcrumb").textContent = breadcrumb;
  for (const button of document.querySelectorAll("[data-studio-route]")) {
    button.classList.toggle("active", button.dataset.studioRoute === (id === "studioSettingsPage" ? "/settings" : "/"));
  }
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function renderRoute() {
  state.route = appRoute();
  if (!state.token || !state.me) {
    stopPolling();
    showOnly("login");
    return;
  }

  if (state.route === "/chat") {
    showOnly("shell");
    await loadChatScreen();
    startPolling();
    return;
  }

  stopPolling();
  if (state.route === "/settings") {
    showOnly("home");
    showStudioPage("studioSettingsPage", "Snack Studio / Settings");
    await loadSettings();
    return;
  }

  if (state.route === "/act") {
    showOnly("actPage");
    return;
  }

  showOnly("home");
  await loadEpisodeRoute();
}

async function finishLoginWithSigner(getPubkey, signChallenge) {
  $("loginError").textContent = "";
  const pubkey = await getPubkey();
  const challenge = await api("/api/auth/challenge", {
    method: "POST",
    body: JSON.stringify({ pubkey }),
  });
  const event = await signChallenge(challenge);
  const result = await api("/api/auth/verify", {
    method: "POST",
    body: JSON.stringify({ event }),
  });
  state.token = result.token;
  state.me = result;
  localStorage.setItem("snack_studio_token", result.token);
  if (window.location.pathname !== "/") history.pushState({}, "", "/");
  await bootApp();
}

async function login() {
  if (!window.nostr) {
    $("loginError").textContent = "No Nostr browser extension was found.";
    return;
  }
  try {
    state.directNsec = "";
    await finishLoginWithSigner(
      () => window.nostr.getPublicKey(),
      (challenge) => window.nostr.signEvent({
        kind: 22242,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["challenge", challenge.nonce], ["client", "snack-studio"]],
        content: challenge.content,
      }),
    );
  } catch (error) {
    $("loginError").textContent = error.message;
  }
}

async function loginWithNsec() {
  $("loginError").textContent = "";
  const input = $("nsecInput");
  const nsec = input.value.trim();
  try {
    await finishLoginWithSigner(
      () => derivePubkeyFromNsec(nsec),
      (challenge) => signLoginChallengeWithNsec(nsec, challenge),
    );
    state.directNsec = nsec;
    input.value = "";
  } catch (error) {
    $("loginError").textContent = error.message;
  }
}

async function bootApp() {
  try {
    state.me = await api("/api/me");
    $("npub").textContent = state.me.npub;
    renderStudioUser(cachedProfile(state.me.pubkey));
    void resolveCurrentUserProfile();
    await renderRoute();
  } catch {
    logout();
  }
}

function shorthandNpub(npub) {
  return npub.length > 20 ? `${npub.slice(0, 12)}…${npub.slice(-6)}` : npub;
}

function renderStudioUser(profile) {
  const name = profileFullName(profile) || "Nostr user";
  const npub = state.me?.npub || "";
  $("studioUserName").textContent = name;
  $("studioNpub").textContent = shorthandNpub(npub);
  $("studioNpub").title = npub;
  const avatar = $("studioUserAvatar");
  avatar.innerHTML = "";
  if (profile?.picture) {
    const img = document.createElement("img");
    img.src = profile.picture;
    img.alt = "";
    avatar.appendChild(img);
  } else {
    avatar.textContent = name.slice(0, 1).toUpperCase();
  }
}

async function resolveCurrentUserProfile() {
  const profile = await resolveProfile({ pubkey: state.me.pubkey, npub: state.me.npub });
  renderStudioUser(profile);
}

function setStudioStatus(message) {
  $("studioStatus").textContent = message;
}

function formatEpisodeStatus(status) {
  return String(status || "")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function statusClass(status) {
  if (["published", "approved", "completed", "complete"].includes(status)) return "statusSuccess";
  if (["failed", "error", "cancelled"].includes(status)) return "statusDanger";
  if (["processing", "running", "applying-result"].includes(status)) return "statusInfo";
  if (["in-review", "needs-review", "timed-out"].includes(status)) return "statusWarning";
  return "statusPending";
}

function formatActivity(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value)) return "Unknown";
  const elapsed = Date.now() - value;
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

async function loadEpisodeRoute() {
  const match = state.route.match(/^\/episodes\/([^/]+)$/);
  if (match) {
    await loadEpisode(decodeURIComponent(match[1]));
    return;
  }
  await loadEpisodes();
}

async function loadEpisodes() {
  showStudioPage("episodesPage", "Snack Studio / Episodes");
  setStudioStatus("Loading episodes…");
  try {
    const payload = await api("/api/episodes");
    state.episodes = payload.episodes || [];
    renderEpisodes();
    setStudioStatus("Ready");
  } catch (error) {
    setStudioStatus(error.message);
    renderEpisodeError(error.message);
  }
}

function renderEpisodeError(message) {
  const list = $("episodeList");
  list.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "episodeEmpty";
  const title = document.createElement("strong");
  title.textContent = "Episodes could not be loaded";
  const detail = document.createElement("span");
  detail.textContent = message;
  empty.append(title, detail);
  list.appendChild(empty);
}

function renderEpisodes() {
  const episodes = state.episodes;
  $("episodeCount").textContent = String(episodes.length);
  $("preparationCount").textContent = String(episodes.filter((episode) => ["transcript-preparation", "ready-for-extraction"].includes(episode.status)).length);
  $("reviewCount").textContent = String(episodes.filter((episode) => episode.status === "in-review").length);
  $("publishedCount").textContent = String(episodes.filter((episode) => episode.status === "published").length);

  const list = $("episodeList");
  list.innerHTML = "";
  if (!episodes.length) {
    const empty = document.createElement("div");
    empty.className = "episodeEmpty";
    const title = document.createElement("strong");
    title.textContent = "No episode workspaces yet";
    const detail = document.createElement("span");
    detail.textContent = "Create the first episode to begin transcript preparation.";
    empty.append(title, detail);
    list.appendChild(empty);
    return;
  }

  for (const episode of episodes) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "episodeRow";
    const identity = document.createElement("span");
    identity.className = "episodeIdentity";
    const title = document.createElement("strong");
    title.textContent = episode.workingTitle;
    const number = document.createElement("span");
    number.textContent = episode.episodeNumber ? `Episode ${episode.episodeNumber}` : "Episode number not set";
    identity.append(title, number);
    const status = document.createElement("span");
    status.className = `statusPill ${statusClass(episode.status)}`;
    status.textContent = formatEpisodeStatus(episode.status);
    const updated = document.createElement("span");
    updated.className = "episodeUpdated metadata";
    updated.textContent = formatActivity(episode.updatedAt);
    const chevron = document.createElement("span");
    chevron.textContent = "→";
    row.append(identity, status, updated, chevron);
    row.addEventListener("click", () => navigate(`/episodes/${encodeURIComponent(episode.id)}`));
    list.appendChild(row);
  }
}

async function loadEpisode(id) {
  showStudioPage("episodePage", "Snack Studio / Episodes / Workspace");
  setStudioStatus("Loading workspace…");
  try {
    const [payload, candidatePayload, curationPayload, pipelinePayload, publicationPayload] = await Promise.all([
      api(`/api/episodes/${encodeURIComponent(id)}`),
      api(`/api/episodes/${encodeURIComponent(id)}/candidates`),
      api(`/api/episodes/${encodeURIComponent(id)}/curation`),
      api(`/api/episodes/${encodeURIComponent(id)}/pipeline-requests`),
      api(`/api/episodes/${encodeURIComponent(id)}/publication-preparation`).catch(() => ({ preparation: null })),
    ]);
    state.activeEpisode = payload.episode;
    state.activeTranscript = payload.transcript || null;
    state.transcriptRevisions = payload.transcriptRevisions || [];
    state.candidates = candidatePayload.candidates || [];
    state.candidateGenerations = candidateGenerations(state.candidates, candidatePayload.generations);
    state.approvedBatch = candidatePayload.approvedBatch || { ready: false, checks: [], candidateIds: [] };
    state.regenerationProposals = candidatePayload.regenerationProposals || {};
    if (!hasCandidateGeneration(state.activeGenerationId)) {
      state.activeGenerationId = state.candidateGenerations.at(-1)?.id || "";
      state.activeCandidateId = "";
    }
    state.curation = curationPayload;
    state.pipelineRequests = pipelinePayload.pipelineRequests || [];
    state.pipelineTimeoutMs = Number(pipelinePayload.timeoutMs || 0);
    state.episodeAuditEvents = payload.auditEvents || [];
    state.publicationPreparation = publicationPayload.preparation || null;
    if (!state.episodeStage || state.episodeStageId !== id) {
      state.episodeStage = episodeWorkspaceStage();
      state.episodeStageId = id;
    }
    if (state.candidates.length && state.episodeStage === "processing") state.episodeStage = "output";
    renderEpisodeWorkspace(payload.episode, payload.transcript, payload.transcriptRevisions || [], payload.auditEvents || [], state.candidates);
    startEpisodePipelinePolling();
    setStudioStatus("Ready");
  } catch (error) {
    setStudioStatus(error.message);
    $("episodeWorkspace").textContent = error.message;
  }
}

function makeWorkspaceField(labelText, input) {
  const label = document.createElement("label");
  label.className = "workspaceField";
  const labelSpan = document.createElement("span");
  labelSpan.textContent = labelText;
  label.append(labelSpan, input);
  return label;
}

function workspaceInput(id, type, value, placeholder = "") {
  const input = document.createElement("input");
  input.id = id;
  input.type = type;
  input.value = value || "";
  input.placeholder = placeholder;
  input.disabled = !state.me?.access?.edit;
  return input;
}

function renderEpisodeWorkspace(episode, transcript, transcriptRevisions, auditEvents, candidates = state.candidates) {
  const workspace = $("episodeWorkspace");
  workspace.innerHTML = "";
  const header = document.createElement("header");
  header.className = "episodeWorkspaceHeader";
  const copy = document.createElement("div");
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow metadata";
  eyebrow.textContent = episode.episodeNumber ? `Episode ${episode.episodeNumber}` : "Episode number not set";
  const title = document.createElement("h1");
  title.textContent = episode.workingTitle;
  const meta = document.createElement("p");
  meta.textContent = `Created ${formatActivity(episode.createdAt)}`;
  copy.append(eyebrow, title, meta);
  const headerActions = document.createElement("div");
  headerActions.className = "episodeWorkspaceHeaderActions";
  const status = document.createElement("span");
  status.className = `statusPill ${statusClass(episode.status)}`;
  status.textContent = formatEpisodeStatus(episode.status);
  header.append(copy);
  const detailsButton = document.createElement("button");
  detailsButton.type = "button";
  detailsButton.className = "btn btnSecondary episodeDetailsButton";
  detailsButton.textContent = state.episodeStage === "details" ? "Back to workflow" : "Details";
  detailsButton.addEventListener("click", () => setEpisodeStage(state.episodeStage === "details" ? episodeWorkspaceStage() : "details"));
  headerActions.append(status, detailsButton);
  header.appendChild(headerActions);

  const flow = document.createElement("nav");
  flow.className = "episodeFlow";
  flow.setAttribute("aria-label", "Episode workflow");
  const stages = [
    { id: "setup", number: "1", label: "Transcript" },
    { id: "processing", number: "2", label: "Generating" },
    { id: "output", number: "3", label: "Review" },
  ];
  for (const stage of stages) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `episodeFlowStep${state.episodeStage === stage.id ? " active" : ""}`;
    button.disabled = stage.id === "processing" && !state.pipelineRequests.length || stage.id === "output" && !candidates.length;
    button.innerHTML = `<span>${stage.number}</span><strong>${stage.label}</strong>`;
    button.addEventListener("click", () => setEpisodeStage(stage.id));
    flow.appendChild(button);
  }
  if (candidates.length) flow.classList.add("hidden");

  const metadataForm = document.createElement("form");
  metadataForm.className = "workspaceSection metadataForm";
  const metadataHeader = document.createElement("div");
  metadataHeader.className = "workspaceSectionHeader";
  metadataHeader.innerHTML = "<div><h2>Episode metadata</h2><p>Private preparation fields can be refined before publication.</p></div>";
  const metadataSave = document.createElement("button");
  metadataSave.type = "submit";
  metadataSave.className = "btn btnPrimary";
  metadataSave.textContent = "Save metadata";
  metadataSave.disabled = !state.me?.access?.edit;
  metadataHeader.appendChild(metadataSave);
  const fields = document.createElement("div");
  fields.className = "workspaceFieldGrid";
  fields.append(
    makeWorkspaceField("Episode number", workspaceInput("workspaceEpisodeNumber", "number", episode.episodeNumber)),
    makeWorkspaceField("Working title", workspaceInput("workspaceWorkingTitle", "text", episode.workingTitle)),
    makeWorkspaceField("Public title", workspaceInput("workspacePublicTitle", "text", episode.publicTitle, "Optional canonical title")),
    makeWorkspaceField("Recorded on", workspaceInput("workspaceRecordedOn", "date", episode.recordedOn)),
    makeWorkspaceField("Audio URL", workspaceInput("workspaceAudioUrl", "url", episode.audioUrl, "https://…")),
    makeWorkspaceField("Video URL", workspaceInput("workspaceVideoUrl", "url", episode.videoUrl, "https://…")),
  );
  const notes = document.createElement("textarea");
  notes.id = "workspaceEditorialNotes";
  notes.rows = 4;
  notes.value = episode.editorialNotes || "";
  notes.placeholder = "Private preparation notes";
  notes.disabled = !state.me?.access?.edit;
  const metadataError = document.createElement("p");
  metadataError.className = "formError";
  metadataError.id = "metadataFormError";
  metadataForm.append(metadataHeader, fields, makeWorkspaceField("Editorial notes", notes), metadataError);
  metadataForm.addEventListener("submit", saveEpisodeMetadata);

  const transcriptForm = document.createElement("form");
  transcriptForm.className = "workspaceSection transcriptForm";
  const transcriptHeader = document.createElement("div");
  transcriptHeader.className = "workspaceSectionHeader";
  const transcriptHeaderCopy = document.createElement("div");
  const transcriptTitle = document.createElement("h2");
  transcriptTitle.textContent = "Transcript";
  const transcriptMeta = document.createElement("p");
  transcriptMeta.textContent = transcript
    ? `Active revision ${transcript.revisionNumber} · ${transcript.sourceKind === "upload" ? transcript.originalFilename || "Uploaded file" : "Pasted text"} · ${Math.round(transcript.sizeBytes / 1024)} KB · ${transcript.sha256.slice(0, 12)}…`
    : "Paste the source transcript to create the first immutable revision.";
  transcriptHeaderCopy.append(transcriptTitle, transcriptMeta);
  const transcriptSave = document.createElement("button");
  transcriptSave.type = "submit";
  transcriptSave.className = "btn btnPrimary";
  transcriptSave.textContent = transcript ? "Save new revision" : "Save transcript";
  transcriptSave.disabled = !state.me?.access?.edit;
  transcriptHeader.append(transcriptHeaderCopy, transcriptSave);
  const transcriptText = document.createElement("textarea");
  transcriptText.id = "workspaceTranscriptText";
  transcriptText.className = "transcriptEditor";
  transcriptText.rows = 18;
  transcriptText.value = transcript?.transcriptText || "";
  transcriptText.placeholder = "Paste the episode transcript here…";
  transcriptText.disabled = !state.me?.access?.edit;
  const uploadRow = document.createElement("div");
  uploadRow.className = "transcriptUploadRow";
  const uploadCopy = document.createElement("div");
  const uploadTitle = document.createElement("strong");
  uploadTitle.textContent = "Or upload a text file";
  const uploadHelp = document.createElement("span");
  uploadHelp.textContent = ".txt, UTF-8, up to 5 MB. The stored filename is generated safely.";
  uploadCopy.append(uploadTitle, uploadHelp);
  const uploadControls = document.createElement("div");
  const uploadInput = document.createElement("input");
  uploadInput.id = "workspaceTranscriptFile";
  uploadInput.type = "file";
  uploadInput.accept = ".txt,text/plain";
  uploadInput.disabled = !state.me?.access?.edit;
  const uploadButton = document.createElement("button");
  uploadButton.type = "button";
  uploadButton.className = "btn btnSecondary";
  uploadButton.textContent = "Upload transcript";
  uploadButton.disabled = !state.me?.access?.edit;
  uploadButton.addEventListener("click", uploadTranscriptFile);
  uploadControls.append(uploadInput, uploadButton);
  uploadRow.append(uploadCopy, uploadControls);
  const changeNote = workspaceInput("workspaceTranscriptNote", "text", "", transcript ? "What changed in this revision?" : "Initial pasted transcript");
  const transcriptError = document.createElement("p");
  transcriptError.className = "formError";
  transcriptError.id = "transcriptFormError";
  transcriptForm.append(transcriptHeader, transcriptText, uploadRow, makeWorkspaceField("Revision note", changeNote), transcriptError);
  transcriptForm.addEventListener("submit", saveTranscriptRevision);

  const history = document.createElement("section");
  history.className = "workspaceSection revisionHistory";
  const historyHeader = document.createElement("div");
  historyHeader.className = "workspaceSectionHeader";
  historyHeader.innerHTML = `<div><h2>Revision history</h2><p>${transcriptRevisions.length} transcript revision${transcriptRevisions.length === 1 ? "" : "s"}; ${auditEvents.length} episode audit event${auditEvents.length === 1 ? "" : "s"}.</p></div>`;
  history.appendChild(historyHeader);
  if (!transcriptRevisions.length) {
    const empty = document.createElement("p");
    empty.textContent = "No transcript revisions yet.";
    history.appendChild(empty);
  } else {
    const list = document.createElement("div");
    list.className = "revisionList";
    for (const revision of transcriptRevisions) {
      const item = document.createElement("div");
      const isActive = revision.id === episode.activeTranscriptRevisionId;
      if (isActive) item.classList.add("active");
      const identity = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = `Revision ${revision.revisionNumber}${isActive ? " · Active" : ""}`;
      const note = document.createElement("span");
      note.textContent = revision.changeNote || (revision.revisionNumber === 1 ? "Initial pasted transcript" : "No revision note");
      identity.append(name, note);
      const actions = document.createElement("div");
      actions.className = "revisionActions";
      const facts = document.createElement("span");
      facts.className = "metadata";
      const sourceLabel = revision.sourceKind === "upload" ? revision.originalFilename || "Uploaded .txt" : "Pasted text";
      facts.textContent = `${sourceLabel} · ${Math.round(revision.sizeBytes / 1024)} KB · ${revision.sha256.slice(0, 10)}… · ${formatActivity(revision.createdAt)}`;
      actions.appendChild(facts);
      if (!isActive) {
        const activate = document.createElement("button");
        activate.type = "button";
        activate.className = "btn btnSecondary";
        activate.textContent = "Make active";
        activate.disabled = !state.me?.access?.edit;
        activate.addEventListener("click", () => activateTranscript(revision.id));
        actions.appendChild(activate);
      }
      item.append(identity, actions);
      list.appendChild(item);
    }
    history.appendChild(list);
  }
  const pipelineSection = renderPipelineRequestsSection(episode, state.pipelineRequests);
  const candidateSection = renderCandidateSection(episode, candidates);
  const curationSection = renderCurationSection(episode, candidates, state.curation);
  const setupActions = document.createElement("div");
  setupActions.className = "episodeFlowActions";
  const setupHint = document.createElement("p");
  setupHint.textContent = transcript
    ? "The transcript is ready. Metadata can remain incomplete and be refined later."
    : "Add a transcript before starting generation.";
  const start = document.createElement("button");
  start.type = "button";
  start.className = "btn btnPrimary";
  start.textContent = "Start Snack generation";
  start.disabled = !state.me?.access?.edit || !transcript || state.pipelineRequests.some((request) => ["created", "awaiting-authorization", "queued", "running", "applying-result"].includes(request.status));
  start.addEventListener("click", startEpisodeExtraction);
  setupActions.append(setupHint, start);

  const setupStage = document.createElement("div");
  setupStage.className = "episodeStage";
  const uploadPanel = document.createElement("section");
  uploadPanel.className = "transcriptDropPanel";
  const dropInput = document.createElement("input");
  dropInput.type = "file";
  dropInput.accept = ".txt,text/plain";
  dropInput.hidden = true;
  const dropIcon = document.createElement("span");
  dropIcon.className = "transcriptDropIcon";
  dropIcon.textContent = "↑";
  const dropTitle = document.createElement("h2");
  dropTitle.textContent = transcript ? "Transcript ready" : "Upload the episode transcript";
  const dropHelp = document.createElement("p");
  dropHelp.textContent = transcript
    ? `${transcript.originalFilename || "Pasted transcript"} · ${Math.round(transcript.sizeBytes / 1024)} KB`
    : "Drop a .txt file here or choose one from your computer.";
  const choose = document.createElement("button");
  choose.type = "button";
  choose.className = "btn btnSecondary";
  choose.textContent = transcript ? "Replace transcript" : "Choose transcript";
  choose.disabled = !state.me?.access?.edit;
  choose.addEventListener("click", () => dropInput.click());
  dropInput.addEventListener("change", () => uploadAndStartTranscript(dropInput.files?.[0]));
  uploadPanel.addEventListener("dragover", (event) => { event.preventDefault(); uploadPanel.classList.add("dragging"); });
  uploadPanel.addEventListener("dragleave", () => uploadPanel.classList.remove("dragging"));
  uploadPanel.addEventListener("drop", (event) => {
    event.preventDefault();
    uploadPanel.classList.remove("dragging");
    uploadAndStartTranscript(event.dataTransfer?.files?.[0]);
  });
  uploadPanel.append(dropInput, dropIcon, dropTitle, dropHelp, choose);
  if (transcript) uploadPanel.appendChild(start);
  setupStage.append(uploadPanel);
  const processingStage = document.createElement("div");
  processingStage.className = "episodeStage";
  processingStage.append(renderSimplePipelineProgress());
  const outputStage = document.createElement("div");
  outputStage.className = "episodeStage";
  outputStage.append(candidateSection);
  const publicationStage = document.createElement("div");
  publicationStage.className = "episodeStage";
  publicationStage.append(renderPublicationPreparation(episode, candidates));
  const detailsStage = document.createElement("div");
  detailsStage.className = "episodeStage episodeDetailsStage";
  detailsStage.append(metadataForm, transcriptForm, history, pipelineSection, curationSection, renderDeleteEpisodeSection(episode));
  workspace.append(header, flow, state.episodeStage === "details" ? detailsStage : state.episodeStage === "publication" ? publicationStage : state.episodeStage === "processing" ? processingStage : state.episodeStage === "output" ? outputStage : setupStage);
}

function renderPublicationPreparation(episode, candidates) {
  const section = document.createElement("section");
  section.className = "publicationPreparation";
  const header = document.createElement("header");
  header.className = "publicationPreparationHeader";
  const copy = document.createElement("div");
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow metadata";
  eyebrow.textContent = "Publishing";
  const title = document.createElement("h2");
  title.textContent = "Prepare episode package";
  const help = document.createElement("p");
  help.textContent = "Snack Studio is assembling canonical topics, contributor portraits and transcript-grounded thumbnail work for the approved set.";
  copy.append(eyebrow, title, help);
  const back = document.createElement("button");
  back.type = "button";
  back.className = "btn btnSecondary";
  back.textContent = "Back to Snacks";
  back.addEventListener("click", () => setEpisodeStage("output"));
  header.append(copy, back);
  section.appendChild(header);

  const preparation = state.publicationPreparation;
  if (!preparation) {
    const empty = document.createElement("p");
    empty.textContent = "Publication preparation has not started.";
    section.appendChild(empty);
    return section;
  }
  const facts = document.createElement("div");
  facts.className = "publicationPreparationFacts";
  const resolved = preparation.participants?.resolved || [];
  const unresolved = preparation.participants?.unresolved || [];
  const topicsMissing = preparation.needsTopicClassification || [];
  for (const [label, value, stateClass] of [
    ["Approved Snacks", String(preparation.jobs?.length || 0), ""],
    ["Contributor portraits", `${resolved.length} resolved`, unresolved.length ? "statusWarning" : "statusSuccess"],
    ["Topic colours", topicsMissing.length ? `${topicsMissing.length} to classify` : "Resolved", topicsMissing.length ? "statusWarning" : "statusSuccess"],
  ]) {
    const item = document.createElement("div");
    const name = document.createElement("span"); name.textContent = label;
    const valueNode = document.createElement("strong"); valueNode.textContent = value;
    if (stateClass) valueNode.className = `statusPill ${stateClass}`;
    item.append(name, valueNode); facts.appendChild(item);
  }
  section.appendChild(facts);
  if (unresolved.length) {
    const blocker = document.createElement("p");
    blocker.className = "publicationPreparationBlocker";
    blocker.textContent = `New contributor portrait required for ${unresolved.join(", ")}.`;
    section.appendChild(blocker);
  }
  const queue = document.createElement("div");
  queue.className = "publicationThumbnailQueue";
  for (const job of preparation.jobs || []) {
    const candidate = candidates.find((item) => item.id === job.snackCandidateId);
    const row = document.createElement("div");
    const identity = document.createElement("div");
    const name = document.createElement("strong"); name.textContent = candidate?.revision?.publicTitle || "Approved Snack";
    const detail = document.createElement("span"); detail.textContent = job.topicColour ? `Topic colour ${job.topicColour}` : "Topic classification pending";
    identity.append(name, detail);
    const status = document.createElement("span"); status.className = `statusPill ${job.topicColour ? "statusSuccess" : "statusWarning"}`; status.textContent = job.topicColour ? "Ready" : "Needs metadata";
    row.append(identity, status); queue.appendChild(row);
  }
  section.appendChild(queue);
  return section;
}

function renderDeleteEpisodeSection(episode) {
  const active = state.pipelineRequests.some((request) => ["created", "awaiting-authorization", "queued", "running", "applying-result"].includes(request.status));
  const section = document.createElement("section");
  section.className = "workspaceSection deleteEpisodeSection";
  const copy = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = "Delete episode workspace";
  const help = document.createElement("p");
  help.textContent = active
    ? "This workspace can be deleted once the current generation run has finished."
    : "Permanently removes this workspace, its transcript revisions, generated Snacks and run history.";
  copy.append(title, help);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btnDanger";
  button.textContent = "Delete workspace";
  button.disabled = !state.me?.access?.edit || active;
  button.addEventListener("click", () => deleteEpisodeWorkspace(episode));
  section.append(copy, button);
  return section;
}

async function deleteEpisodeWorkspace(episode) {
  const label = episode.episodeNumber ? `Episode ${episode.episodeNumber}, ${episode.workingTitle}` : episode.workingTitle;
  if (!window.confirm(`Permanently delete ${label}?\n\nThis will delete its transcript revisions, generated Snacks and run history. This cannot be undone.`)) return;
  setStudioStatus("Deleting workspace…");
  try {
    await api(`/api/episodes/${encodeURIComponent(episode.id)}`, { method: "DELETE" });
    stopPolling();
    state.activeEpisode = null;
    state.activeTranscript = null;
    state.transcriptRevisions = [];
    state.candidates = [];
    state.pipelineRequests = [];
    state.episodeAuditEvents = [];
    state.episodeStage = "";
    state.episodeStageId = "";
    navigate("/");
  } catch (error) {
    setStudioStatus(error.message);
  }
}

function renderSimplePipelineProgress() {
  const section = document.createElement("section");
  section.className = "simplePipelineProgress";
  const latest = state.pipelineRequests[0] || null;
  const latestRun = latest?.runs?.[0] || null;
  const active = latest && ["created", "awaiting-authorization", "queued", "running", "applying-result"].includes(latest.status);
  const failed = latest && ["failed", "timed-out", "needs-review", "cancelled"].includes(latest.status);
  const title = document.createElement("h2");
  title.textContent = active ? "Generating Snacks" : failed ? "Generation stopped" : "Preparing generation";
  const status = document.createElement("p");
  status.className = "simplePipelineStatus";
  status.textContent = active
    ? latestRun?.progressLabel || "Autopilot is working through the transcript. You can leave this screen and return later."
    : failed ? latest.failureSummary || "The pipeline did not complete." : "The pipeline is being prepared.";
  const track = document.createElement("div");
  track.className = `pipelineProgressTrack${failed ? " failed" : ""}`;
  const bar = document.createElement("span");
  const percent = active ? Math.max(1, Number(latestRun?.progressPercent || 1)) : failed ? 100 : 0;
  if (active && percent <= 1) bar.className = "indeterminate";
  else bar.style.width = `${percent}%`;
  track.appendChild(bar);
  const percentage = document.createElement("strong");
  percentage.className = "pipelinePercentage";
  percentage.textContent = active ? `${percent}%` : failed ? "Stopped" : "";
  section.append(title, status, track, percentage);
  if (failed) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn btnPrimary";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => retryPipelineRequest(latest.id));
    section.appendChild(retry);
  }
  const detail = document.createElement("button");
  detail.type = "button";
  detail.className = "textButton";
  detail.textContent = "View run details";
  detail.addEventListener("click", () => setEpisodeStage("details"));
  section.appendChild(detail);
  return section;
}

function episodeWorkspaceStage() {
  if (state.candidates.length) return "output";
  if (state.pipelineRequests.length) return "processing";
  return "setup";
}

function setEpisodeStage(stage) {
  state.episodeStage = stage;
  renderEpisodeWorkspace(state.activeEpisode, state.activeTranscript, state.transcriptRevisions, state.episodeAuditEvents, state.candidates);
}

function renderPipelineRequestsSection(episode, requests) {
  const section = document.createElement("section");
  section.className = "workspaceSection pipelineRequestSection";
  const header = document.createElement("div");
  header.className = "workspaceSectionHeader";
  header.innerHTML = "<div><h2>Autopilot extraction</h2><p>Durable requests remain attached to the transcript revision that started them.</p></div>";
  section.appendChild(header);
  if (!requests.length) {
    const empty = document.createElement("div");
    empty.className = "candidateEmpty";
    empty.textContent = episode.activeTranscriptRevisionId
      ? "No extraction requests yet. Generate candidates when the transcript is ready."
      : "Save a transcript before preparing an extraction request.";
    section.appendChild(empty);
    return section;
  }
  const list = document.createElement("div");
  list.className = "pipelineRequestList";
  for (const request of requests) {
    const item = document.createElement("div");
    item.className = "pipelineRequestItem";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = formatEpisodeStatus(request.operation);
    const detail = document.createElement("span");
    detail.textContent = `${request.pipelineName} · transcript ${request.inputTranscriptSha256.slice(0, 10)}… · ${request.attemptCount} attempt${request.attemptCount === 1 ? "" : "s"}`;
    copy.append(title, detail);
    if (request.staleInput) {
      const stale = document.createElement("p");
      stale.className = "pipelineRequestWarning";
      stale.textContent = "Generated from an older transcript revision";
      copy.appendChild(stale);
    }
    if (request.failureSummary) {
      const failure = document.createElement("p");
      failure.className = "pipelineRequestFailure";
      failure.textContent = request.failureSummary;
      copy.appendChild(failure);
    }
    if (request.runs?.length) {
      const attempts = document.createElement("details");
      const attemptsSummary = document.createElement("summary");
      attemptsSummary.textContent = "Attempt history";
      attempts.appendChild(attemptsSummary);
      for (const run of request.runs) {
        const attempt = document.createElement("span");
        attempt.textContent = `Attempt ${run.attemptNumber} · ${formatEpisodeStatus(run.status)}${run.failureSummary ? ` · ${run.failureSummary}` : ""}`;
        attempts.appendChild(attempt);
      }
      copy.appendChild(attempts);
    }
    const actions = document.createElement("div");
    actions.className = "pipelineRequestActions";
    const status = document.createElement("span");
    status.className = `statusPill ${statusClass(request.status)}`;
    status.textContent = formatEpisodeStatus(request.status);
    actions.appendChild(status);
    if (["failed", "timed-out", "needs-review", "cancelled", "awaiting-authorization"].includes(request.status)) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "btn btnSecondary";
      const targetPipeline = currentTarget()?.defaultPipeline || "snack-studio-transcript-to-snacks";
      const obsoletePipeline = request.pipelineName !== targetPipeline;
      retry.textContent = obsoletePipeline ? "Return to Setup" : request.status === "awaiting-authorization" ? "Resume" : "Retry";
      retry.disabled = !state.me?.access?.edit;
      retry.addEventListener("click", () => obsoletePipeline ? setEpisodeStage("setup") : retryPipelineRequest(request.id));
      actions.appendChild(retry);
    }
    item.append(copy, actions);
    list.appendChild(item);
  }
  section.appendChild(list);
  return section;
}

async function startEpisodeExtraction() {
  if (!state.activeEpisode) return;
  setStudioStatus("Preparing extraction request…");
  try {
    const prepared = await api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/pipeline-requests`, {
      method: "POST",
      body: JSON.stringify({
        operation: "transcript-to-snacks",
        autopilotTargetId: state.activeAutopilotTargetId || undefined,
        pipelineVersion: CURRENT_SNACK_PIPELINE_VERSION,
        promptSuiteVersion: CURRENT_SNACK_PROMPT_SUITE,
        resultSchemaVersion: "1",
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    await authorizePreparedEpisodeRun(prepared);
  } catch (error) {
    await loadEpisode(state.activeEpisode.id).catch(() => undefined);
    setStudioStatus(error.message);
  }
}

async function retryPipelineRequest(requestId) {
  if (!state.activeEpisode) return;
  const previousRequest = state.pipelineRequests.find((request) => request.id === requestId);
  if (previousRequest?.promptSuiteVersion !== CURRENT_SNACK_PROMPT_SUITE) {
    await startEpisodeExtraction();
    return;
  }
  setStudioStatus("Preparing another attempt…");
  try {
    const prepared = await api(`/api/pipeline-requests/${encodeURIComponent(requestId)}/retry`, { method: "POST", body: "{}" });
    await authorizePreparedEpisodeRun(prepared);
  } catch (error) {
    await loadEpisode(state.activeEpisode.id).catch(() => undefined);
    setStudioStatus(error.message);
  }
}

async function authorizePreparedEpisodeRun(prepared) {
  state.pipelineRequests = [prepared.pipelineRequest, ...state.pipelineRequests.filter((request) => request.id !== prepared.pipelineRequest.id)];
  state.activeGenerationId = "";
  state.activeCandidateId = "";
  state.episodeStage = "processing";
  renderEpisodeWorkspace(state.activeEpisode, state.activeTranscript, state.transcriptRevisions, [], state.candidates);
  if (!prepared.requiresAutopilotAuth || !prepared.triggerRequest) throw new Error("Autopilot trigger was not prepared");
  setStudioStatus("Authorize extraction with Nostr…");
  const triggerRequest = structuredClone(prepared.triggerRequest);
  const references = triggerRequest.body?.input?.localContext?.references || [];
  for (const reference of references) {
    reference.authorization = await signNip98Request({ url: reference.url, method: "GET" });
  }
  const autopilotAuthorization = await signNip98Request(triggerRequest);
  setStudioStatus("Starting Autopilot extraction…");
  await api(`/api/episode-pipeline-runs/${encodeURIComponent(prepared.runId)}/start`, {
    method: "POST",
    body: JSON.stringify({ autopilotAuthorization, triggerRequest }),
  });
  await loadEpisode(state.activeEpisode.id);
  setStudioStatus("Extraction started");
}

function startEpisodePipelinePolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  const active = state.pipelineRequests.some((request) => ["queued", "running", "applying-result"].includes(request.status));
  if (!active || !state.activeEpisode) {
    state.pollTimer = null;
    return;
  }
  const episodeId = state.activeEpisode.id;
  state.pollTimer = setInterval(async () => {
    if (state.activeEpisode?.id !== episodeId || !/^\/episodes\//.test(window.location.pathname)) return stopPolling();
    try {
      const [pipelinePayload, candidatePayload, curationPayload] = await Promise.all([
        api(`/api/episodes/${encodeURIComponent(episodeId)}/pipeline-requests`),
        api(`/api/episodes/${encodeURIComponent(episodeId)}/candidates`),
        api(`/api/episodes/${encodeURIComponent(episodeId)}/curation`),
      ]);
      state.pipelineRequests = pipelinePayload.pipelineRequests || [];
      state.pipelineTimeoutMs = Number(pipelinePayload.timeoutMs || 0);
      state.candidates = candidatePayload.candidates || [];
      state.candidateGenerations = candidateGenerations(state.candidates, candidatePayload.generations);
      state.approvedBatch = candidatePayload.approvedBatch || { ready: false, checks: [], candidateIds: [] };
      state.regenerationProposals = candidatePayload.regenerationProposals || {};
      if (!hasCandidateGeneration(state.activeGenerationId)) {
        state.activeGenerationId = state.candidateGenerations.at(-1)?.id || "";
        state.activeCandidateId = "";
      }
      state.curation = curationPayload;
      if (state.candidates.length) state.episodeStage = "output";
      renderEpisodeWorkspace(state.activeEpisode, state.activeTranscript, state.transcriptRevisions, [], state.candidates);
      if (!state.pipelineRequests.some((request) => ["queued", "running", "applying-result"].includes(request.status))) stopPolling();
    } catch {
      // Preserve the last durable state and try again on the next interval.
    }
  }, 4000);
}

function renderCurationSection(episode, candidates, curation) {
  const section = document.createElement("section");
  section.className = "workspaceSection curationSection";
  const header = document.createElement("div");
  header.className = "workspaceSectionHeader";
  header.innerHTML = `<div><h2>Package curation</h2><p>Order newsletter snacks, curate conceptual relationships, and resolve readiness checks.</p></div>`;
  const readiness = document.createElement("span");
  readiness.className = `statusPill ${curation.validation?.ready ? "statusSuccess" : "statusPending"}`;
  readiness.textContent = curation.validation?.ready ? "Package ready" : "Work in progress";
  header.appendChild(readiness);
  const grid = document.createElement("div");
  grid.className = "curationGrid";

  const newsletter = document.createElement("div");
  newsletter.className = "curationPanel";
  const newsletterTitle = document.createElement("h3");
  newsletterTitle.textContent = "Newsletter selection";
  const newsletterHelp = document.createElement("p");
  newsletterHelp.textContent = "Select and order three or four accepted snacks.";
  newsletter.append(newsletterTitle, newsletterHelp);
  const selectedIds = (curation.newsletterItems || []).map((item) => item.candidateId);
  const accepted = candidates.filter((candidate) => candidate.reviewDecision === "accepted");
  const choices = document.createElement("div");
  choices.className = "newsletterChoices";
  for (const candidate of accepted) {
    const row = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedIds.includes(candidate.id);
    checkbox.disabled = !state.me?.access?.edit || (!checkbox.checked && selectedIds.length >= 4);
    checkbox.addEventListener("change", () => {
      const next = checkbox.checked ? [...selectedIds, candidate.id] : selectedIds.filter((id) => id !== candidate.id);
      void saveNewsletterOrder(next);
    });
    const label = document.createElement("span");
    label.textContent = candidate.revision.publicTitle;
    row.append(checkbox, label);
    choices.appendChild(row);
  }
  if (!accepted.length) choices.textContent = "Accept candidates before selecting newsletter items.";
  newsletter.appendChild(choices);
  if (curation.newsletterItems?.length) {
    const order = document.createElement("div");
    order.className = "newsletterOrder";
    for (const item of curation.newsletterItems) {
      const row = document.createElement("div");
      const label = document.createElement("span");
      label.textContent = `${item.position}. ${item.title}`;
      const actions = document.createElement("div");
      for (const [direction, symbol] of [[-1, "↑"], [1, "↓"]]) {
        const move = document.createElement("button");
        move.type = "button";
        move.className = "btn btnSecondary";
        move.textContent = symbol;
        move.disabled = !state.me?.access?.edit || item.position + direction < 1 || item.position + direction > selectedIds.length;
        move.addEventListener("click", () => moveNewsletterItem(item.candidateId, direction));
        actions.appendChild(move);
      }
      row.append(label, actions);
      order.appendChild(row);
    }
    newsletter.appendChild(order);
  }

  const relationships = document.createElement("div");
  relationships.className = "curationPanel";
  const relHeader = document.createElement("div");
  relHeader.className = "curationPanelHeader";
  const relTitle = document.createElement("h3");
  relTitle.textContent = "Conceptual relationships";
  relHeader.appendChild(relTitle);
  if (!curation.relationships?.length && candidates.length >= 3) {
    const suggest = document.createElement("button");
    suggest.type = "button";
    suggest.className = "btn btnSecondary";
    suggest.textContent = "Add fixture suggestions";
    suggest.disabled = !state.me?.access?.edit;
    suggest.addEventListener("click", generateFixtureRelationships);
    relHeader.appendChild(suggest);
  }
  relationships.appendChild(relHeader);
  const relForm = document.createElement("form");
  relForm.className = "relationshipForm";
  for (const [id, label] of [["relationshipSource", "Source snack"], ["relationshipTarget", "Target snack"]]) {
    const select = document.createElement("select");
    select.id = id;
    for (const candidate of candidates) {
      const option = document.createElement("option"); option.value = candidate.id; option.textContent = candidate.revision.publicTitle; select.appendChild(option);
    }
    relForm.appendChild(makeWorkspaceField(label, select));
  }
  const type = document.createElement("select");
  type.id = "relationshipType";
  for (const value of ["overlaps", "develops", "contradicts", "revises", "exemplifies", "enables", "caused-by"]) {
    const option = document.createElement("option"); option.value = value; option.textContent = formatEpisodeStatus(value); type.appendChild(option);
  }
  relForm.appendChild(makeWorkspaceField("Type", type));
  const explanation = document.createElement("input"); explanation.id = "relationshipExplanation"; explanation.placeholder = "Why are these ideas related?";
  relForm.appendChild(makeWorkspaceField("Explanation", explanation));
  const add = document.createElement("button"); add.type = "submit"; add.className = "btn btnPrimary"; add.textContent = "Add relationship"; add.disabled = !state.me?.access?.edit || candidates.length < 2;
  relForm.appendChild(add);
  relForm.addEventListener("submit", createManualRelationship);
  relationships.appendChild(relForm);
  const relList = document.createElement("div"); relList.className = "relationshipList";
  for (const relationship of curation.relationships || []) {
    const row = document.createElement("div");
    const copy = document.createElement("div");
    const name = document.createElement("strong"); name.textContent = `${relationship.sourceTitle} → ${formatEpisodeStatus(relationship.relationshipType)} → ${relationship.targetTitle}`;
    const note = document.createElement("span"); note.textContent = relationship.explanation || "No explanation";
    copy.append(name, note);
    const actions = document.createElement("div");
    const statePill = document.createElement("span"); statePill.className = `statusPill ${relationship.reviewState === "approved" ? "statusSuccess" : relationship.reviewState === "rejected" ? "statusDanger" : "statusPending"}`; statePill.textContent = formatEpisodeStatus(relationship.reviewState);
    actions.appendChild(statePill);
    if (relationship.reviewState === "draft") {
      for (const [reviewState, label] of [["approved", "Approve"], ["rejected", "Reject"]]) {
        const button = document.createElement("button"); button.type = "button"; button.className = "btn btnSecondary"; button.textContent = label; button.disabled = !state.me?.access?.edit;
        button.addEventListener("click", () => reviewRelationship(relationship.id, reviewState)); actions.appendChild(button);
      }
    }
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "btn btnTransparent"; remove.textContent = "Remove"; remove.disabled = !state.me?.access?.edit;
    remove.addEventListener("click", () => removeRelationship(relationship.id)); actions.appendChild(remove);
    row.append(copy, actions); relList.appendChild(row);
  }
  relationships.appendChild(relList);
  grid.append(newsletter, relationships);

  const validation = document.createElement("div"); validation.className = "packageValidation";
  for (const check of curation.validation?.checks || []) {
    const item = document.createElement("div");
    const marker = document.createElement("span"); marker.textContent = check.ok ? "✓" : "○";
    const message = document.createElement("span"); message.textContent = check.message;
    item.className = check.ok ? "pass" : "pending"; item.append(marker, message); validation.appendChild(item);
  }
  section.append(header, grid, validation);
  return section;
}

function renderCandidateSection(episode, candidates) {
  const section = document.createElement("section");
  section.className = "workspaceSection candidateSection";
  const header = document.createElement("div");
  header.className = "workspaceSectionHeader";
  const copy = document.createElement("div");
  const title = document.createElement("h2");
  title.textContent = "Episode Snacks";
  const counts = candidates.reduce((result, candidate) => {
    result[candidate.reviewDecision] = (result[candidate.reviewDecision] || 0) + 1;
    return result;
  }, {});
  const summary = document.createElement("p");
  summary.textContent = candidates.length
    ? `${candidates.length} Snacks · ${counts.accepted || 0} accepted`
    : "Generate local fixtures to exercise the review workflow before pipeline integration.";
  copy.append(title, summary);
  header.appendChild(copy);
  if (!candidates.length) {
    const generate = document.createElement("button");
    generate.type = "button";
    generate.className = "btn btnPrimary";
    generate.textContent = "Generate fixture candidates";
    generate.disabled = !state.me?.access?.edit || !episode.activeTranscriptRevisionId;
    generate.addEventListener("click", generateFixtureCandidates);
    header.appendChild(generate);
  }
  if (!candidates.length) {
    section.appendChild(header);
    const empty = document.createElement("div");
    empty.className = "candidateEmpty";
    empty.textContent = episode.activeTranscriptRevisionId
      ? "No candidate set exists for this episode yet."
      : "Save a transcript before generating candidates.";
    section.appendChild(empty);
    return section;
  }
  const layout = document.createElement("div");
  layout.className = "candidateReviewLayout";
  const list = document.createElement("div");
  list.className = "candidateQueue";
  const listHeader = document.createElement("header");
  listHeader.className = "candidateQueueHeader";
  const listHeading = document.createElement("div");
  const listTitle = document.createElement("h2");
  listTitle.textContent = "Episode Snacks";
  const listSummary = document.createElement("p");
  listSummary.textContent = `${counts.accepted || 0} accepted across ${state.candidateGenerations.length} run${state.candidateGenerations.length === 1 ? "" : "s"}`;
  listHeading.append(listTitle, listSummary);
  const generationControls = document.createElement("div");
  generationControls.className = "candidateGenerationControls";
  const generationSelect = document.createElement("select");
  generationSelect.setAttribute("aria-label", "Snack generation run");
  const approvedOption = document.createElement("option");
  approvedOption.value = "approved";
  approvedOption.textContent = `Approved · ${counts.accepted || 0} Snacks`;
  generationSelect.appendChild(approvedOption);
  for (const generation of [...state.candidateGenerations].reverse()) {
    const option = document.createElement("option");
    option.value = generation.id;
    option.textContent = `Run ${generation.sequence} · ${generation.candidateCount} Snacks`;
    generationSelect.appendChild(option);
  }
  generationSelect.value = state.activeGenerationId || state.candidateGenerations.at(-1)?.id || "";
  generationSelect.addEventListener("change", () => {
    state.activeGenerationId = generationSelect.value;
    state.activeCandidateId = "";
    renderEpisodeWorkspace(state.activeEpisode, state.activeTranscript, state.transcriptRevisions, [], state.candidates);
  });
  const generateAgain = document.createElement("button");
  generateAgain.type = "button";
  generateAgain.className = "btn btnSecondary";
  generateAgain.textContent = "Generate again";
  generateAgain.disabled = !state.me?.access?.edit || state.pipelineRequests.some((request) => ["created", "awaiting-authorization", "queued", "running", "applying-result"].includes(request.status));
  generateAgain.addEventListener("click", startEpisodeExtraction);
  generationControls.append(generationSelect, generateAgain);
  listHeader.append(listHeading, generationControls);
  list.appendChild(listHeader);
  const activeGenerationId = generationSelect.value;
  if (activeGenerationId === "approved") {
    const batchBar = document.createElement("div");
    batchBar.className = "approvedBatchBar";
    const batchStatus = document.createElement("span");
    const firstIncomplete = state.approvedBatch.checks?.find((check) => !check.ok);
    batchStatus.textContent = episode.status === "approved"
      ? "Final set approved"
      : state.approvedBatch.ready ? "Final set ready" : firstIncomplete?.message || "Build the final set";
    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "btn btnPrimary";
    approve.textContent = episode.status === "approved" ? "Approved" : "Approve final set";
    approve.disabled = !state.me?.access?.edit || !state.approvedBatch.ready || episode.status === "approved";
    approve.addEventListener("click", approveFinalCandidateBatch);
    batchBar.append(batchStatus, approve);
    if (episode.status === "approved") {
      const prepare = document.createElement("button");
      prepare.type = "button";
      prepare.className = "btn btnSecondary";
      prepare.textContent = state.publicationPreparation ? "Open publication" : "Prepare publication";
      prepare.disabled = !state.me?.access?.edit;
      prepare.addEventListener("click", preparePublication);
      batchBar.appendChild(prepare);
    }
    list.appendChild(batchBar);
  }
  const visibleCandidates = activeGenerationId === "approved"
    ? candidates.filter((candidate) => candidate.reviewDecision === "accepted").sort((a, b) => (a.approvedPosition || 0) - (b.approvedPosition || 0))
    : candidates.filter((candidate) => candidateGenerationId(candidate) === activeGenerationId);
  for (const candidate of visibleCandidates) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `candidateQueueItem${candidate.id === state.activeCandidateId ? " active" : ""}`;
    const itemTitle = document.createElement("strong");
    itemTitle.textContent = candidate.revision.publicTitle;
    const itemMeta = document.createElement("span");
    itemMeta.textContent = formatEpisodeStatus(candidate.reviewDecision);
    button.append(itemTitle, itemMeta);
    button.addEventListener("click", () => {
      state.activeCandidateId = candidate.id;
      renderEpisodeWorkspace(state.activeEpisode, state.activeTranscript, state.transcriptRevisions, [], state.candidates);
    });
    list.appendChild(button);
  }
  layout.appendChild(list);
  const active = visibleCandidates.find((candidate) => candidate.id === state.activeCandidateId) || visibleCandidates[0];
  if (!active) {
    const empty = document.createElement("div");
    empty.className = "candidateEmpty";
    empty.textContent = activeGenerationId === "approved" ? "Accepted Snacks from any run will collect here." : "This run has no generated Snacks.";
    layout.appendChild(empty);
    section.appendChild(layout);
    return section;
  }
  if (state.activeCandidateId !== active.id) state.activeCandidateId = active.id;
  layout.appendChild(renderCandidateReader(active));
  section.appendChild(layout);
  return section;
}

function renderCandidateReader(candidate) {
  const article = document.createElement("article");
  article.className = "candidateReader";
  const toolbar = document.createElement("div");
  toolbar.className = "candidateReaderToolbar";
  const stateLabel = document.createElement("span");
  stateLabel.className = `statusPill ${candidate.reviewDecision === "accepted" ? "statusSuccess" : "statusPending"}`;
  stateLabel.textContent = formatEpisodeStatus(candidate.reviewDecision);
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "btn btnSecondary";
  edit.textContent = "Open editor";
  edit.addEventListener("click", () => openCandidateEditor(candidate));
  toolbar.append(stateLabel, edit);
  const title = document.createElement("h2");
  title.textContent = candidate.revision.publicTitle;
  const standfirst = document.createElement("p");
  standfirst.className = "candidateReaderStandfirst";
  standfirst.textContent = candidate.revision.standfirst;
  const body = document.createElement("div");
  body.className = "candidateReaderBody";
  for (const paragraph of String(candidate.revision.bodyMarkdown || "").split(/\n\s*\n/).filter(Boolean)) {
    const p = document.createElement("p");
    p.textContent = paragraph;
    body.appendChild(p);
  }
  const decisions = document.createElement("div");
  decisions.className = "candidateReaderDecisions";
  for (const [decision, label] of [["accepted", "Accept Snack"], ["rejected", "Reject"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = decision === "accepted" ? "btn btnPrimary" : "btn btnSecondary";
    button.textContent = label;
    button.disabled = !state.me?.access?.edit;
    button.addEventListener("click", () => updateCandidateDecision(candidate.id, decision));
    decisions.appendChild(button);
  }
  article.append(toolbar, title, standfirst, body, decisions);
  return article;
}

function openCandidateEditor(candidate) {
  const dialog = document.createElement("dialog");
  dialog.className = "candidateEditorDialog";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "candidateEditorDialogClose";
  close.setAttribute("aria-label", "Close editor");
  close.textContent = "x";
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  dialog.append(close, renderCandidateEditor(candidate));
  document.body.appendChild(dialog);
  dialog.showModal();
}

function openRegenerationDialog(candidate) {
  const dialog = document.createElement("dialog");
  dialog.className = "regenerationDialog";
  const form = document.createElement("form");
  form.className = "regenerationForm";
  const title = document.createElement("h2");
  title.textContent = "Generate an alternative";
  const help = document.createElement("p");
  help.textContent = "The current Snack will remain unchanged. Add a focused instruction, or leave this blank for a faithful alternative rendering.";
  const instruction = document.createElement("textarea");
  instruction.rows = 4;
  instruction.maxLength = 1000;
  instruction.placeholder = "For example, make the title more concrete or improve the flow between paragraphs.";
  const actions = document.createElement("div");
  actions.className = "regenerationActions";
  const errorMessage = document.createElement("p");
  errorMessage.className = "formError";
  const cancel = document.createElement("button");
  cancel.type = "button"; cancel.className = "btn btnSecondary"; cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => dialog.close());
  const generate = document.createElement("button");
  generate.type = "submit"; generate.className = "btn btnPrimary"; generate.textContent = "Generate alternative";
  actions.append(cancel, generate);
  form.append(title, help, makeWorkspaceField("Optional instruction", instruction), errorMessage, actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); generate.disabled = true;
    try {
      errorMessage.textContent = "";
      await startSnackRegeneration(candidate, instruction.value);
      dialog.close();
    } catch (error) {
      generate.disabled = false;
      errorMessage.textContent = error.message;
      setStudioStatus(error.message);
    }
  });
  dialog.addEventListener("close", () => dialog.remove());
  dialog.appendChild(form); document.body.appendChild(dialog); dialog.showModal();
}

async function startSnackRegeneration(candidate, instruction) {
  setStudioStatus("Preparing Snack alternative…");
  const prepared = await api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/pipeline-requests`, {
    method: "POST",
    body: JSON.stringify({
      operation: "snack-regeneration", pipelineName: "snack-studio-regenerate-snack",
      pipelineVersion: "1", promptSuiteVersion: CURRENT_SNACK_PROMPT_SUITE,
      resultSchemaVersion: "1", targetCandidateId: candidate.id,
      regenerationInstruction: instruction.trim() || null, idempotencyKey: crypto.randomUUID(),
      autopilotTargetId: state.activeAutopilotTargetId || undefined,
    }),
  });
  state.pipelineRequests = [prepared.pipelineRequest, ...state.pipelineRequests.filter((request) => request.id !== prepared.pipelineRequest.id)];
  const triggerRequest = structuredClone(prepared.triggerRequest);
  for (const reference of triggerRequest.body?.input?.localContext?.references || []) {
    reference.authorization = await signNip98Request({ url: reference.url, method: "GET" });
  }
  const autopilotAuthorization = await signNip98Request(triggerRequest);
  await api(`/api/episode-pipeline-runs/${encodeURIComponent(prepared.runId)}/start`, {
    method: "POST", body: JSON.stringify({ autopilotAuthorization, triggerRequest }),
  });
  await loadEpisode(state.activeEpisode.id);
  setStudioStatus("Generating Snack alternative…");
}

function candidateField(labelText, key, value, multiline = false) {
  const input = multiline ? document.createElement("textarea") : document.createElement("input");
  input.dataset.candidateField = key;
  input.value = value || "";
  input.disabled = !state.me?.access?.edit;
  if (multiline) input.rows = key === "bodyMarkdown" ? 10 : 3;
  return makeWorkspaceField(labelText, input);
}

function renderCandidateEditor(candidate) {
  const form = document.createElement("form");
  form.className = "candidateEditor";
  form.dataset.candidateId = candidate.id;
  const header = document.createElement("div");
  header.className = "candidateEditorHeader";
  const meta = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = `Candidate revision ${candidate.revision.revisionNumber}`;
  const detail = document.createElement("span");
  detail.textContent = `${formatEpisodeStatus(candidate.reviewDecision)} · ${candidate.revisionCount} saved revision${candidate.revisionCount === 1 ? "" : "s"}`;
  meta.append(title, detail);
  const decisions = document.createElement("div");
  decisions.className = "candidateDecisions";
  for (const [decision, label] of [["accepted", "Accept"], ["rejected", "Reject"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = decision === "accepted" ? "btn btnPrimary" : "btn btnSecondary";
    button.textContent = label;
    button.disabled = !state.me?.access?.edit;
    button.addEventListener("click", () => updateCandidateDecision(candidate.id, decision));
    decisions.appendChild(button);
  }
  const regenerate = document.createElement("button");
  regenerate.type = "button";
  regenerate.className = "btn btnSecondary";
  regenerate.textContent = "Generate alternative";
  regenerate.disabled = !state.me?.access?.edit || state.pipelineRequests.some((request) => request.operation === "snack-regeneration" && request.targetCandidateId === candidate.id && ["created", "awaiting-authorization", "queued", "running", "applying-result"].includes(request.status));
  regenerate.addEventListener("click", () => openRegenerationDialog(candidate));
  decisions.appendChild(regenerate);
  header.append(meta, decisions);
  const revisionNav = document.createElement("div");
  revisionNav.className = "candidateRevisionNav";
  const revisionLabel = document.createElement("span");
  revisionLabel.textContent = "Revision history";
  revisionNav.appendChild(revisionLabel);
  for (const revision of candidate.revisions || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn btnSecondary${revision.id === candidate.currentRevisionId ? " active" : ""}`;
    button.textContent = `v${revision.revisionNumber}`;
    button.title = revision.changeNote || `${formatEpisodeStatus(revision.origin)} revision`;
    button.disabled = !state.me?.access?.edit || revision.id === candidate.currentRevisionId;
    button.addEventListener("click", () => activateCandidateRevision(candidate.id, revision.id));
    revisionNav.appendChild(button);
  }
  const provenance = document.createElement("div");
  provenance.className = "candidateProvenance";
  if (candidate.revision.origin === "pipeline") {
    const provenanceTitle = document.createElement("strong");
    provenanceTitle.textContent = "Pipeline provenance";
    const provenanceDetail = document.createElement("span");
    provenanceDetail.textContent = [
      candidate.revision.promptSuiteVersion,
      candidate.revision.pipelineVersion ? `pipeline ${candidate.revision.pipelineVersion}` : null,
      candidate.revision.sourceTranscriptRevisionId ? `transcript ${candidate.revision.sourceTranscriptRevisionId.slice(0, 8)}…` : null,
      candidate.selectionId ? `selection ${candidate.selectionId}` : null,
    ].filter(Boolean).join(" · ");
    provenance.append(provenanceTitle, provenanceDetail);
    for (const warning of candidate.revision.validationWarnings || []) {
      const warningRow = document.createElement("p");
      warningRow.textContent = warning;
      provenance.appendChild(warningRow);
    }
  }
  const grid = document.createElement("div");
  grid.className = "workspaceFieldGrid";
  grid.append(
    candidateField("Public title", "publicTitle", candidate.revision.publicTitle),
    candidateField("Editorial title", "editorialTitle", candidate.revision.editorialTitle),
    candidateField("Attribution", "attribution", candidate.revision.attribution),
    candidateField("Primary topic", "primaryTopic", candidate.revision.primaryTopic),
    candidateField("Related topics", "relatedTopics", (candidate.revision.relatedTopics || []).join(", ")),
    candidateField("Transcript timestamp", "transcriptTimestamp", candidate.revision.transcriptTimestamp),
    candidateField("SEO title", "seoTitle", candidate.revision.seoTitle),
  );
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "btn btnPrimary";
  save.textContent = "Save new revision";
  save.disabled = !state.me?.access?.edit;
  const error = document.createElement("p");
  error.className = "formError";
  error.dataset.candidateError = "";
  const proposed = (state.regenerationProposals[candidate.id] || []).find((proposal) => proposal.status === "proposed");
  form.append(
    header,
    ...(proposed ? [renderRegenerationComparison(candidate, proposed)] : []),
    revisionNav,
    ...(candidate.revision.origin === "pipeline" ? [provenance] : []),
    grid,
    candidateField("Standfirst", "standfirst", candidate.revision.standfirst, true),
    candidateField("Body Markdown", "bodyMarkdown", candidate.revision.bodyMarkdown, true),
    candidateField("Transcript evidence", "transcriptExcerpt", candidate.revision.transcriptExcerpt, true),
    candidateField("SEO description", "seoDescription", candidate.revision.seoDescription, true),
    candidateField("Revision note", "changeNote", ""),
    error,
    save,
  );
  form.addEventListener("submit", saveCandidateRevision);
  return form;
}

function comparisonArticle(label, titleText, standfirstText, bodyText) {
  const article = document.createElement("article");
  const labelElement = document.createElement("span"); labelElement.className = "eyebrow"; labelElement.textContent = label;
  const title = document.createElement("h3"); title.textContent = titleText;
  const standfirst = document.createElement("p"); standfirst.className = "candidateReaderStandfirst"; standfirst.textContent = standfirstText;
  const body = document.createElement("div"); body.className = "candidateReaderBody";
  for (const paragraph of String(bodyText || "").split(/\n\s*\n/).filter(Boolean)) {
    const p = document.createElement("p"); p.textContent = paragraph; body.appendChild(p);
  }
  article.append(labelElement, title, standfirst, body); return article;
}

function renderRegenerationComparison(candidate, proposal) {
  const section = document.createElement("section"); section.className = "regenerationComparison";
  const heading = document.createElement("div"); heading.className = "regenerationComparisonHeader";
  const copy = document.createElement("div");
  const title = document.createElement("h3"); title.textContent = "Alternative ready";
  const rationale = document.createElement("p"); rationale.textContent = proposal.rationale || proposal.instruction || "A grounded alternative rendering of the same idea.";
  copy.append(title, rationale);
  const actions = document.createElement("div"); actions.className = "regenerationActions";
  for (const [resolution, label, className] of [["discard", "Discard", "btn btnSecondary"], ["adopt", "Adopt as new revision", "btn btnPrimary"]]) {
    const button = document.createElement("button"); button.type = "button"; button.className = className; button.textContent = label;
    button.addEventListener("click", () => resolveRegenerationProposal(proposal.id, resolution)); actions.appendChild(button);
  }
  heading.append(copy, actions);
  const comparison = document.createElement("div"); comparison.className = "regenerationComparisonGrid";
  comparison.append(
    comparisonArticle("Current", candidate.revision.publicTitle, candidate.revision.standfirst, candidate.revision.bodyMarkdown),
    comparisonArticle("Proposed", proposal.publicTitle, proposal.standfirst, proposal.bodyMarkdown),
  );
  section.append(heading, comparison); return section;
}

async function resolveRegenerationProposal(proposalId, resolution) {
  setStudioStatus(resolution === "adopt" ? "Adopting alternative…" : "Discarding alternative…");
  try {
    await api(`/api/regeneration-proposals/${encodeURIComponent(proposalId)}/${resolution}`, { method: "POST", body: "{}" });
    document.querySelector(".candidateEditorDialog")?.close();
    await refreshCandidates();
    setStudioStatus(resolution === "adopt" ? "Alternative adopted as a new revision" : "Alternative discarded");
  } catch (error) { setStudioStatus(error.message); }
}

async function refreshCandidates() {
  const [payload, curation, episodePayload] = await Promise.all([
    api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/candidates`),
    api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/curation`),
    api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}`),
  ]);
  state.activeEpisode = episodePayload.episode;
  state.candidates = payload.candidates || [];
  state.candidateGenerations = candidateGenerations(state.candidates, payload.generations);
  state.approvedBatch = payload.approvedBatch || { ready: false, checks: [], candidateIds: [] };
  state.regenerationProposals = payload.regenerationProposals || {};
  if (!hasCandidateGeneration(state.activeGenerationId)) {
    state.activeGenerationId = state.candidateGenerations.at(-1)?.id || "";
    state.activeCandidateId = "";
  }
  state.curation = curation;
  renderEpisodeWorkspace(state.activeEpisode, state.activeTranscript, state.transcriptRevisions, [], state.candidates);
}

async function approveFinalCandidateBatch() {
  setStudioStatus("Approving final Snack set…");
  try {
    const payload = await api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/approved-candidate-batch`, {
      method: "POST",
      body: "{}",
    });
    state.activeEpisode = payload.episode;
    state.approvedBatch = payload.approvedBatch;
    renderEpisodeWorkspace(state.activeEpisode, state.activeTranscript, state.transcriptRevisions, [], state.candidates);
    setStudioStatus("Final Snack set approved");
  } catch (error) {
    setStudioStatus(error.message);
  }
}

async function preparePublication() {
  if (!state.activeEpisode) return;
  setStudioStatus("Preparing publication…");
  try {
    const payload = state.publicationPreparation
      ? { preparation: state.publicationPreparation }
      : await api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/publication-preparation`, { method: "POST", body: JSON.stringify({}) });
    state.publicationPreparation = payload.preparation;
    state.episodeStage = "publication";
    renderEpisodeWorkspace(state.activeEpisode, state.activeTranscript, state.transcriptRevisions, state.episodeAuditEvents, state.candidates);
    setStudioStatus("Ready");
  } catch (error) {
    setStudioStatus(error.message);
  }
}

async function refreshCuration() {
  state.curation = await api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/curation`);
  renderEpisodeWorkspace(state.activeEpisode, state.activeTranscript, state.transcriptRevisions, [], state.candidates);
}

async function saveNewsletterOrder(candidateIds) {
  setStudioStatus("Saving newsletter selection…");
  try {
    await api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/newsletter-items`, { method: "PUT", body: JSON.stringify({ candidateIds }) });
    await refreshCuration();
    setStudioStatus("Newsletter selection saved");
  } catch (error) {
    setStudioStatus(error.message);
  }
}

function moveNewsletterItem(candidateId, direction) {
  const ids = state.curation.newsletterItems.map((item) => item.candidateId);
  const index = ids.indexOf(candidateId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ids.length) return;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  void saveNewsletterOrder(ids);
}

async function generateFixtureRelationships() {
  setStudioStatus("Adding relationship suggestions…");
  try {
    await api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/fixture-relationships`, { method: "POST", body: JSON.stringify({}) });
    await refreshCuration();
    setStudioStatus("Relationship suggestions added for review");
  } catch (error) {
    setStudioStatus(error.message);
  }
}

async function createManualRelationship(event) {
  event.preventDefault();
  setStudioStatus("Adding relationship…");
  try {
    await api("/api/relationships", { method: "POST", body: JSON.stringify({
      episodeId: state.activeEpisode.id,
      sourceCandidateId: $("relationshipSource").value,
      targetCandidateId: $("relationshipTarget").value,
      relationshipType: $("relationshipType").value,
      explanation: $("relationshipExplanation").value,
    }) });
    await refreshCuration();
    setStudioStatus("Relationship added");
  } catch (error) {
    setStudioStatus(error.message);
  }
}

async function reviewRelationship(id, reviewState) {
  try {
    await api(`/api/relationships/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ reviewState }) });
    await refreshCuration();
    setStudioStatus(`Relationship ${reviewState}`);
  } catch (error) { setStudioStatus(error.message); }
}

async function removeRelationship(id) {
  try {
    await api(`/api/relationships/${encodeURIComponent(id)}`, { method: "DELETE" });
    await refreshCuration();
    setStudioStatus("Relationship removed");
  } catch (error) { setStudioStatus(error.message); }
}

async function generateFixtureCandidates() {
  setStudioStatus("Generating fixture candidates…");
  try {
    const payload = await api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/fixture-candidates`, { method: "POST", body: JSON.stringify({}) });
    state.candidates = payload.candidates;
    state.activeEpisode = payload.episode;
    state.activeCandidateId = state.candidates[0]?.id || "";
    renderEpisodeWorkspace(state.activeEpisode, state.activeTranscript, state.transcriptRevisions, [], state.candidates);
    setStudioStatus(`${state.candidates.length} fixture candidates generated`);
  } catch (error) {
    setStudioStatus(error.message);
  }
}

async function updateCandidateDecision(candidateId, reviewDecision) {
  setStudioStatus("Saving review decision…");
  try {
    await api(`/api/candidates/${encodeURIComponent(candidateId)}`, { method: "PATCH", body: JSON.stringify({ reviewDecision }) });
    await refreshCandidates();
    setStudioStatus(`${formatEpisodeStatus(reviewDecision)} saved`);
  } catch (error) {
    setStudioStatus(error.message);
  }
}

async function saveCandidateRevision(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = {};
  for (const field of form.querySelectorAll("[data-candidate-field]")) values[field.dataset.candidateField] = field.value;
  const error = form.querySelector("[data-candidate-error]");
  error.textContent = "";
  setStudioStatus("Saving candidate revision…");
  try {
    await api(`/api/candidates/${encodeURIComponent(form.dataset.candidateId)}`, { method: "PATCH", body: JSON.stringify(values) });
    await refreshCandidates();
    setStudioStatus("New candidate revision saved");
  } catch (requestError) {
    error.textContent = requestError.message;
    setStudioStatus("Candidate revision not saved");
  }
}

async function activateCandidateRevision(candidateId, revisionId) {
  setStudioStatus("Restoring candidate revision…");
  try {
    await api(`/api/candidates/${encodeURIComponent(candidateId)}/revisions/${encodeURIComponent(revisionId)}/active`, {
      method: "PUT",
      body: JSON.stringify({}),
    });
    await refreshCandidates();
    setStudioStatus("Candidate revision restored for review");
  } catch (error) {
    setStudioStatus(error.message);
  }
}

async function saveEpisodeMetadata(event) {
  event.preventDefault();
  const error = $("metadataFormError");
  error.textContent = "";
  setStudioStatus("Saving metadata…");
  try {
    const payload = await api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        episodeNumber: $("workspaceEpisodeNumber").value,
        workingTitle: $("workspaceWorkingTitle").value,
        publicTitle: $("workspacePublicTitle").value,
        recordedOn: $("workspaceRecordedOn").value,
        audioUrl: $("workspaceAudioUrl").value,
        videoUrl: $("workspaceVideoUrl").value,
        editorialNotes: $("workspaceEditorialNotes").value,
      }),
    });
    state.activeEpisode = payload.episode;
    setStudioStatus("Metadata saved");
    await loadEpisode(payload.episode.id);
  } catch (requestError) {
    error.textContent = requestError.message;
    setStudioStatus("Metadata not saved");
  }
}

async function saveTranscriptRevision(event) {
  event.preventDefault();
  const error = $("transcriptFormError");
  error.textContent = "";
  setStudioStatus("Saving transcript revision…");
  try {
    const payload = await api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/transcript-revisions`, {
      method: "POST",
      body: JSON.stringify({
        transcriptText: $("workspaceTranscriptText").value,
        changeNote: $("workspaceTranscriptNote").value,
      }),
    });
    state.activeEpisode = payload.episode;
    state.activeTranscript = payload.transcript;
    state.transcriptRevisions = payload.transcriptRevisions;
    renderEpisodeWorkspace(payload.episode, payload.transcript, payload.transcriptRevisions, payload.auditEvents || [], state.candidates);
    setStudioStatus(`Transcript revision ${payload.transcript.revisionNumber} saved`);
  } catch (requestError) {
    error.textContent = requestError.message;
    setStudioStatus("Transcript not saved");
  }
}

async function uploadTranscriptFile() {
  const error = $("transcriptFormError");
  error.textContent = "";
  const input = $("workspaceTranscriptFile");
  const file = input.files?.[0];
  if (!file) {
    error.textContent = "Choose a .txt transcript first.";
    return;
  }
  setStudioStatus("Uploading transcript…");
  const formData = new FormData();
  formData.set("file", file);
  formData.set("changeNote", $("workspaceTranscriptNote").value);
  try {
    const payload = await apiForm(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/transcript-revisions`, formData);
    state.activeEpisode = payload.episode;
    state.activeTranscript = payload.transcript;
    state.transcriptRevisions = payload.transcriptRevisions;
    renderEpisodeWorkspace(payload.episode, payload.transcript, payload.transcriptRevisions, payload.auditEvents || [], state.candidates);
    setStudioStatus(`${file.name} uploaded as revision ${payload.transcript.revisionNumber}`);
  } catch (requestError) {
    error.textContent = requestError.message;
    setStudioStatus("Transcript upload failed");
  }
}

async function uploadAndStartTranscript(file) {
  if (!file) return;
  if (!state.me?.access?.edit) return;
  if (!file.name.toLowerCase().endsWith(".txt")) {
    setStudioStatus("Choose a .txt transcript");
    return;
  }
  setStudioStatus("Uploading transcript…");
  const formData = new FormData();
  formData.set("file", file);
  formData.set("changeNote", state.activeTranscript ? "Replacement transcript" : "Initial transcript");
  try {
    const payload = await apiForm(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/transcript-revisions`, formData);
    state.activeEpisode = payload.episode;
    state.activeTranscript = payload.transcript;
    state.transcriptRevisions = payload.transcriptRevisions;
    state.episodeAuditEvents = payload.auditEvents || state.episodeAuditEvents;
    setStudioStatus("Transcript uploaded. Preparing Snack generation…");
    await startEpisodeExtraction();
  } catch (error) {
    setStudioStatus(error.message);
  }
}

async function activateTranscript(revisionId) {
  setStudioStatus("Activating transcript revision…");
  try {
    const payload = await api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/transcript-revisions/${encodeURIComponent(revisionId)}/active`, {
      method: "PUT",
      body: JSON.stringify({}),
    });
    state.activeEpisode = payload.episode;
    state.activeTranscript = payload.transcript;
    state.transcriptRevisions = payload.transcriptRevisions;
    renderEpisodeWorkspace(payload.episode, payload.transcript, payload.transcriptRevisions, payload.auditEvents || [], state.candidates);
    setStudioStatus(`Revision ${payload.transcript.revisionNumber} is active`);
  } catch (requestError) {
    setStudioStatus(requestError.message);
  }
}

function openEpisodeDialog() {
  $("episodeForm").reset();
  $("episodeFormError").textContent = "";
  $("episodeDialog").showModal();
  $("episodeTitleInput").focus();
}

function closeEpisodeDialog() {
  $("episodeDialog").close();
}

async function createEpisodeWorkspace(event) {
  event.preventDefault();
  const error = $("episodeFormError");
  error.textContent = "";
  const submit = $("episodeForm").querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const episodeNumberValue = $("episodeNumberInput").value.trim();
    const payload = await api("/api/episodes", {
      method: "POST",
      body: JSON.stringify({
        episodeNumber: episodeNumberValue ? Number(episodeNumberValue) : null,
        workingTitle: $("episodeTitleInput").value.trim(),
      }),
    });
    closeEpisodeDialog();
    navigate(`/episodes/${encodeURIComponent(payload.episode.id)}`);
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    submit.disabled = false;
  }
}

function logout() {
  state.token = "";
  state.me = null;
  state.activeChatId = "";
  state.directNsec = "";
  localStorage.removeItem("snack_studio_token");
  localStorage.removeItem("snack_studio_chat");
  localStorage.removeItem("chat_wapp_token");
  localStorage.removeItem("chat_wapp_chat");
  $("nsecInput").value = "";
  stopPolling();
  showOnly("login");
}

async function loadChatScreen() {
  await loadRuntimeSettings();
  await loadChats();
  if (!state.activeChatId || !state.chats.find((chat) => chat.id === state.activeChatId)) {
    if (state.chats[0]) state.activeChatId = state.chats[0].id;
    else await newChat();
  }
  await loadActiveChat();
}

async function loadChats() {
  const payload = await api("/api/chats");
  state.chats = payload.chats || [];
  renderChats();
}

async function loadSettings() {
  await loadRuntimeSettings();
  if (state.me?.access?.edit) await loadDbStatus().catch((error) => setStatus(error.message));
  renderSettings();
  renderAutopilotTargets();
  renderPipelineOptions();
  renderAccessRules();
  renderDbStatus();
}

async function loadRuntimeSettings() {
  const payload = await api("/api/settings");
  state.settings = payload.settings;
  state.accessRules = payload.accessRules || [];
  if (!state.activeAutopilotTargetId) {
    state.activeAutopilotTargetId = state.settings?.currentAutopilotTargetId || "";
    if (state.activeAutopilotTargetId) localStorage.setItem("snack_studio_autopilot_target", state.activeAutopilotTargetId);
  }
  const target = currentTarget();
  if (!state.activePipelineName) {
    state.activePipelineName = target?.defaultPipeline || state.settings?.defaultPipeline || "";
    if (state.activePipelineName) localStorage.setItem("snack_studio_pipeline", state.activePipelineName);
  }
  renderChatRunControls();
}

function renderSettings() {
  const target = currentTarget() || state.settings?.autopilotTargets?.[0] || null;
  $("autopilotLabelInput").value = target?.label || "";
  $("autopilotUrlInput").value = target?.url || state.settings?.autopilotUrl || "";
  $("pipelineInput").value = target?.defaultPipeline || state.settings?.defaultPipeline || "";
  const canEdit = Boolean(state.me?.access?.edit);
  for (const id of [
    "autopilotTargetSelect",
    "autopilotLabelInput",
    "autopilotUrlInput",
    "pipelineInput",
    "pipelineSelect",
    "saveSettingsButton",
    "newTargetButton",
    "deleteTargetButton",
    "accessNpubInput",
    "accessRoleSelect",
    "addAccessButton",
    "refreshDbButton",
    "exportDbButton",
    "importDbInput",
    "importDbButton",
    "clearImportButton",
  ]) {
    $(id).disabled = !canEdit;
  }
}

function currentTarget() {
  const targets = state.settings?.autopilotTargets || [];
  return targets.find((target) => target.id === state.activeAutopilotTargetId)
    || targets.find((target) => target.id === state.settings?.currentAutopilotTargetId)
    || targets[0]
    || null;
}

function renderAutopilotTargets() {
  const targets = state.settings?.autopilotTargets || [];
  for (const id of ["autopilotTargetSelect", "chatAutopilotSelect"]) {
    const select = $(id);
    if (!select) continue;
    select.innerHTML = "";
    for (const target of targets) {
      const option = document.createElement("option");
      option.value = target.id;
      option.textContent = target.label;
      select.appendChild(option);
    }
    select.value = currentTarget()?.id || "";
  }
}

function renderPipelineOptions() {
  for (const id of ["pipelineSelect", "chatPipelineSelect"]) {
    const select = $(id);
    if (!select) continue;
    select.innerHTML = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = state.pipelines.length ? "Select a pipeline" : "Use target default";
    select.appendChild(empty);
    for (const pipeline of state.pipelines) {
      const option = document.createElement("option");
      option.value = pipeline.name || pipeline.slug || pipeline.id;
      option.textContent = `${pipeline.name || pipeline.slug || pipeline.id}${pipeline.version ? ` v${pipeline.version}` : ""}`;
      select.appendChild(option);
    }
    const selected = id === "chatPipelineSelect" ? state.activePipelineName : $("pipelineInput").value;
    if (selected) select.value = selected;
  }
}

function renderChatRunControls() {
  renderAutopilotTargets();
  renderPipelineOptions();
  const target = currentTarget();
  if (target && !$("chatPipelineSelect").value && !state.activePipelineName) {
    state.activePipelineName = target.defaultPipeline;
    localStorage.setItem("snack_studio_pipeline", state.activePipelineName);
  }
  $("chatPipelineSelect").value = state.activePipelineName || target?.defaultPipeline || "";
}

function renderAccessRules() {
  const list = $("accessList");
  list.innerHTML = "";
  const canEdit = Boolean(state.me?.access?.edit);
  for (const rule of state.accessRules) {
    const item = document.createElement("div");
    item.className = "accessItem";
    item.dataset.pubkey = rule.pubkey;
    const profile = cachedProfile(rule.pubkey);
    const identity = document.createElement("div");
    identity.className = "accessIdentity";
    const avatar = document.createElement("div");
    avatar.className = "accessAvatar";
    if (profile?.picture) {
      const img = document.createElement("img");
      img.src = profile.picture;
      img.alt = "";
      avatar.appendChild(img);
    } else {
      avatar.textContent = profileInitial(rule, profile);
    }
    const label = document.createElement("div");
    label.className = "accessLabel";
    const name = document.createElement("strong");
    name.textContent = displayNameForRule(rule, profile);
    const meta = document.createElement("span");
    meta.textContent = `${rule.role === "edit" ? "Edit" : "Read"} - ${rule.npub}`;
    label.append(name, meta);
    identity.append(avatar, label);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Remove";
    button.disabled = !canEdit;
    button.addEventListener("click", () => removeAccessRule(rule));
    item.append(identity, button);
    list.appendChild(item);
    if (!profile) {
      void resolveProfile(rule).then(() => updateAccessRuleProfile(rule));
    }
  }
}

function updateAccessRuleProfile(rule) {
  const item = $(`accessList`).querySelector(`[data-pubkey="${CSS.escape(rule.pubkey)}"]`);
  const profile = cachedProfile(rule.pubkey);
  if (!item || !profile) return;
  const avatar = item.querySelector(".accessAvatar");
  const name = item.querySelector(".accessLabel strong");
  if (avatar) {
    avatar.innerHTML = "";
    if (profile.picture) {
      const img = document.createElement("img");
      img.src = profile.picture;
      img.alt = "";
      avatar.appendChild(img);
    } else {
      avatar.textContent = profileInitial(rule, profile);
    }
  }
  if (name) name.textContent = displayNameForRule(rule, profile);
}

async function resolveProfile(rule) {
  const existing = cachedProfile(rule.pubkey);
  if (existing) return existing;
  const profile = await fetchNostrProfile(rule.pubkey).catch(() => null);
  const normalized = {
    pubkey: rule.pubkey,
    name: typeof profile?.name === "string" ? profile.name : "",
    displayName: typeof profile?.display_name === "string" ? profile.display_name : typeof profile?.displayName === "string" ? profile.displayName : "",
    firstName: typeof profile?.first_name === "string" ? profile.first_name : typeof profile?.firstName === "string" ? profile.firstName : "",
    lastName: typeof profile?.last_name === "string" ? profile.last_name : typeof profile?.lastName === "string" ? profile.lastName : "",
    picture: typeof profile?.picture === "string" ? profile.picture : "",
    cachedAt: Date.now(),
  };
  state.profiles[rule.pubkey] = normalized;
  saveProfileCache();
  return normalized;
}

async function fetchNostrProfile(pubkey) {
  const attempts = PROFILE_RELAYS.map((relay) => fetchProfileFromRelay(relay, pubkey));
  const result = await Promise.any(attempts);
  return result;
}

function fetchProfileFromRelay(relayUrl, pubkey) {
  return new Promise((resolve, reject) => {
    const subId = `profile-${pubkey.slice(0, 8)}-${Math.random().toString(16).slice(2)}`;
    let bestEvent = null;
    let settled = false;
    const socket = new WebSocket(relayUrl);
    const timer = setTimeout(() => {
      finish(bestEvent ? parseProfileEvent(bestEvent) : null);
    }, 2500);

    function finish(value, error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.send(JSON.stringify(["CLOSE", subId]));
      } catch {}
      try {
        socket.close();
      } catch {}
      if (error || !value) reject(error || new Error("profile not found"));
      else resolve(value);
    }

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify(["REQ", subId, { kinds: [0], authors: [pubkey], limit: 1 }]));
    });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!Array.isArray(message)) return;
      if (message[0] === "EVENT" && message[1] === subId && message[2]?.kind === 0) {
        if (!bestEvent || Number(message[2].created_at || 0) > Number(bestEvent.created_at || 0)) bestEvent = message[2];
      }
      if (message[0] === "EOSE" && message[1] === subId) finish(bestEvent ? parseProfileEvent(bestEvent) : null);
    });
    socket.addEventListener("error", () => finish(null, new Error(`relay failed: ${relayUrl}`)));
  });
}

function parseProfileEvent(event) {
  const profile = JSON.parse(event.content || "{}");
  return profile && typeof profile === "object" && !Array.isArray(profile) ? profile : null;
}

async function saveSettings() {
  try {
    const payload = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        autopilotTargetId: currentTarget()?.id,
        autopilotLabel: $("autopilotLabelInput").value.trim(),
        autopilotUrl: $("autopilotUrlInput").value.trim(),
        defaultPipeline: $("pipelineInput").value.trim(),
      }),
    });
    state.settings = payload.settings;
    state.activeAutopilotTargetId = payload.settings.currentAutopilotTargetId;
    state.activePipelineName = currentTarget()?.defaultPipeline || payload.settings.defaultPipeline || "";
    localStorage.setItem("snack_studio_autopilot_target", state.activeAutopilotTargetId);
    localStorage.setItem("snack_studio_pipeline", state.activePipelineName);
    renderSettings();
    renderAutopilotTargets();
    renderChatRunControls();
    setStatus("Settings saved");
  } catch (error) {
    setStatus(error.message);
  }
}

async function loadPipelines() {
  try {
    setStatus("Authorizing pipeline list");
    const autopilotTargetId = currentTarget()?.id || state.activeAutopilotTargetId;
    const prepared = await api("/api/autopilot/pipelines", {
      method: "POST",
      body: JSON.stringify({ autopilotTargetId }),
    });
    let payload = prepared;
    if (prepared.requiresAutopilotAuth && prepared.triggerRequest) {
      const autopilotAuthorization = await signNip98Request(prepared.triggerRequest);
      payload = await api("/api/autopilot/pipelines", {
        method: "POST",
        body: JSON.stringify({ autopilotAuthorization, autopilotTargetId }),
      });
    }
    state.pipelines = payload.pipelines || [];
    savePipelinesCache();
    renderPipelineOptions();
    setStatus(`Loaded ${state.pipelines.length} pipelines`);
  } catch (error) {
    setStatus(error.message);
  }
}

async function createAutopilotTarget() {
  try {
    const payload = await api("/api/autopilot-targets", {
      method: "POST",
      body: JSON.stringify({
        label: "New Autopilot",
        url: $("autopilotUrlInput").value.trim() || "http://127.0.0.1:3256",
        defaultPipeline: $("pipelineInput").value.trim() || "snack-studio-transcript-to-snacks",
      }),
    });
    state.settings = payload.settings;
    state.activeAutopilotTargetId = payload.target.id;
    state.activePipelineName = payload.target.defaultPipeline;
    localStorage.setItem("snack_studio_autopilot_target", state.activeAutopilotTargetId);
    localStorage.setItem("snack_studio_pipeline", state.activePipelineName);
    renderSettings();
    renderAutopilotTargets();
    renderChatRunControls();
    setStatus("Autopilot target added");
  } catch (error) {
    setStatus(error.message);
  }
}

async function deleteCurrentAutopilotTarget() {
  const target = currentTarget();
  if (!target) return;
  try {
    const payload = await api(`/api/autopilot-targets/${encodeURIComponent(target.id)}`, { method: "DELETE" });
    state.settings = payload.settings;
    state.activeAutopilotTargetId = payload.settings.currentAutopilotTargetId;
    state.activePipelineName = currentTarget()?.defaultPipeline || "";
    localStorage.setItem("snack_studio_autopilot_target", state.activeAutopilotTargetId);
    localStorage.setItem("snack_studio_pipeline", state.activePipelineName);
    renderSettings();
    renderAutopilotTargets();
    renderChatRunControls();
    setStatus("Autopilot target deleted");
  } catch (error) {
    setStatus(error.message);
  }
}

async function selectAutopilotTarget(targetId) {
  if (!targetId) return;
  state.activeAutopilotTargetId = targetId;
  localStorage.setItem("snack_studio_autopilot_target", targetId);
  const target = currentTarget();
  state.activePipelineName = target?.defaultPipeline || "";
  localStorage.setItem("snack_studio_pipeline", state.activePipelineName);
  try {
    const payload = await api("/api/autopilot-targets/current", {
      method: "PUT",
      body: JSON.stringify({ autopilotTargetId: targetId }),
    });
    state.settings = payload.settings;
  } catch {
    // Local selection still works for the current browser session.
  }
  renderSettings();
  renderAutopilotTargets();
  renderChatRunControls();
}

async function loadDbStatus() {
  state.dbStatus = await api("/api/db/status");
  renderDbStatus();
}

function renderDbStatus() {
  const meta = $("dbMeta");
  const list = $("snapshotList");
  if (!meta || !list) return;
  const status = state.dbStatus;
  if (!status) {
    meta.textContent = "DB status unavailable.";
    list.innerHTML = "";
    return;
  }
  meta.innerHTML = "";
  const rows = [
    ["Path", status.dbPath],
    ["Size", `${Math.round(Number(status.sizeBytes || 0) / 1024)} KB`],
    ["Migration", status.migrations?.latest || "none"],
    ["Pending import", status.pendingImport ? "yes - restart required" : "no"],
  ];
  for (const [label, value] of rows) {
    const div = document.createElement("div");
    div.innerHTML = `<strong></strong><span></span>`;
    div.querySelector("strong").textContent = label;
    div.querySelector("span").textContent = value;
    meta.appendChild(div);
  }
  list.innerHTML = "";
  for (const snapshot of status.snapshots || []) {
    const item = document.createElement("div");
    item.className = "snapshotItem";
    const info = document.createElement("div");
    info.innerHTML = `<strong></strong><span></span>`;
    info.querySelector("strong").textContent = snapshot.filename;
    info.querySelector("span").textContent = `${snapshot.kind} - ${Math.round(Number(snapshot.sizeBytes || 0) / 1024)} KB`;
    const actions = document.createElement("div");
    actions.className = "snapshotActions";
    const download = document.createElement("button");
    download.type = "button";
    download.textContent = "Download";
    download.addEventListener("click", () => downloadSnapshot(snapshot.filename));
    const restore = document.createElement("button");
    restore.type = "button";
    restore.textContent = "Stage";
    restore.addEventListener("click", () => stageSnapshot(snapshot.filename));
    actions.append(download, restore);
    item.append(info, actions);
    list.appendChild(item);
  }
}

async function exportDbSnapshot() {
  try {
    const payload = await api("/api/db/snapshots", {
      method: "POST",
      body: JSON.stringify({ note: $("snapshotNoteInput").value.trim() }),
    });
    state.dbStatus = payload.status;
    $("snapshotNoteInput").value = "";
    renderDbStatus();
    setStatus("Snapshot exported");
  } catch (error) {
    setStatus(error.message);
  }
}

async function stageSnapshot(filename) {
  try {
    const payload = await api("/api/db/import", {
      method: "POST",
      body: JSON.stringify({ filename }),
    });
    state.dbStatus = payload.status;
    renderDbStatus();
    setStatus("Import staged; restart the app to replace the SQLite DB");
  } catch (error) {
    setStatus(error.message);
  }
}

async function downloadSnapshot(filename) {
  try {
    const res = await fetch(`/api/db/snapshots/${encodeURIComponent(filename)}/download`, {
      headers: state.token ? { authorization: `Bearer ${state.token}` } : {},
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || res.statusText);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    setStatus(error.message);
  }
}

async function stageUploadedDb() {
  const file = $("importDbInput").files?.[0];
  if (!file) {
    setStatus("Choose a SQLite file first");
    return;
  }
  try {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/db/import", {
      method: "POST",
      headers: state.token ? { authorization: `Bearer ${state.token}` } : {},
      body: form,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || res.statusText);
    state.dbStatus = payload.status;
    $("importDbInput").value = "";
    renderDbStatus();
    setStatus("Import staged; restart the app to replace the SQLite DB");
  } catch (error) {
    setStatus(error.message);
  }
}

async function clearPendingImport() {
  try {
    const payload = await api("/api/db/import", { method: "DELETE" });
    state.dbStatus = payload.status;
    renderDbStatus();
    setStatus("Pending import cleared");
  } catch (error) {
    setStatus(error.message);
  }
}

async function addAccess() {
  try {
    const payload = await api("/api/access-rules", {
      method: "POST",
      body: JSON.stringify({
        npub: $("accessNpubInput").value.trim(),
        role: $("accessRoleSelect").value,
      }),
    });
    state.accessRules = payload.accessRules || [];
    $("accessNpubInput").value = "";
    renderAccessRules();
    setStatus("Access updated");
  } catch (error) {
    setStatus(error.message);
  }
}

async function removeAccessRule(rule) {
  try {
    const payload = await api(`/api/access-rules/${encodeURIComponent(rule.role)}/${encodeURIComponent(rule.npub)}`, {
      method: "DELETE",
    });
    state.accessRules = payload.accessRules || [];
    renderAccessRules();
    setStatus("Access updated");
  } catch (error) {
    setStatus(error.message);
  }
}

function renderChats() {
  const list = $("chatList");
  list.innerHTML = "";
  for (const chat of state.chats) {
    const button = document.createElement("button");
    button.className = `chatItem${chat.id === state.activeChatId ? " active" : ""}`;
    button.innerHTML = `<strong></strong><span></span>`;
    button.querySelector("strong").textContent = chat.title;
    button.querySelector("span").textContent = chat.preview || "No messages yet";
    button.addEventListener("click", async () => {
      state.activeChatId = chat.id;
      localStorage.setItem("snack_studio_chat", chat.id);
      renderChats();
      await loadActiveChat();
    });
    list.appendChild(button);
  }
}

async function newChat() {
  const payload = await api("/api/chats", { method: "POST", body: "{}" });
  state.activeChatId = payload.chat.id;
  localStorage.setItem("snack_studio_chat", state.activeChatId);
  await loadChats();
  await loadActiveChat();
}

async function loadActiveChat() {
  if (!state.activeChatId) return;
  const payload = await api(`/api/chats/${encodeURIComponent(state.activeChatId)}/messages`);
  $("chatTitle").textContent = payload.chat.title;
  renderMessages(payload.messages || []);
  renderChats();
}

function renderMessages(messages) {
  const box = $("messages");
  box.innerHTML = "";
  for (const message of messages) {
    const node = document.createElement("div");
    node.className = `message ${message.role} ${message.status}`;
    node.textContent = message.status === "pending" ? "Thinking..." : message.content;
    box.appendChild(node);
  }
  box.scrollTop = box.scrollHeight;
  const pending = messages.some((message) => message.status === "pending");
  setStatus(pending ? "Pipeline running" : "Ready");
}

async function sendMessage(event) {
  event.preventDefault();
  const input = $("messageInput");
  const content = input.value.trim();
  if (!content || !state.activeChatId) return;
  input.value = "";
  $("sendButton").disabled = true;
  try {
    const payload = await api(`/api/chats/${encodeURIComponent(state.activeChatId)}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content,
        autopilotTargetId: currentTarget()?.id || state.activeAutopilotTargetId,
        pipelineName: $("chatPipelineSelect").value || state.activePipelineName || currentTarget()?.defaultPipeline,
      }),
    });
    renderMessages(payload.messages || []);
    if (payload.requiresAutopilotAuth && payload.triggerRequest) {
      setStatus("Authorizing pipeline");
      const autopilotAuthorization = await signNip98Request(payload.triggerRequest);
      const started = await api(`/api/pipeline-runs/${encodeURIComponent(payload.runId)}/start`, {
        method: "POST",
        body: JSON.stringify({ autopilotAuthorization }),
      });
      renderMessages(started.messages || []);
    }
    await loadChats();
  } catch (error) {
    setStatus(error.message);
  } finally {
    $("sendButton").disabled = false;
    input.focus();
  }
}

async function signNip98Request(triggerRequest) {
  const tags = [
    ["u", triggerRequest.url],
    ["method", triggerRequest.method || "POST"],
  ];
  if (triggerRequest.body !== undefined) {
    const bodyJson = JSON.stringify(triggerRequest.body);
    tags.push(["payload", await sha256Hex(bodyJson)]);
  }
  const eventTemplate = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: "",
  };
  const event = state.directNsec
    ? signEventWithNsec(state.directNsec, eventTemplate)
    : window.nostr
      ? await window.nostr.signEvent(eventTemplate)
      : null;
  if (!event) throw new Error("No Nostr signer available. Sign in with nsec or use a browser extension.");
  return `Nostr ${base64Utf8(JSON.stringify(event))}`;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    if (state.route === "/chat" && state.activeChatId && state.token) {
      await loadActiveChat().catch(() => undefined);
      await loadChats().catch(() => undefined);
    }
  }, 1500);
}

$("loginButton").addEventListener("click", login);
$("nsecLoginButton").addEventListener("click", loginWithNsec);
$("nsecInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void loginWithNsec();
  }
});
$("logoutButton").addEventListener("click", logout);
$("newChatButton").addEventListener("click", newChat);
$("studioLogoutButton").addEventListener("click", logout);
$("newEpisodeButton").addEventListener("click", openEpisodeDialog);
$("closeEpisodeDialogButton").addEventListener("click", closeEpisodeDialog);
$("cancelEpisodeButton").addEventListener("click", closeEpisodeDialog);
$("episodeForm").addEventListener("submit", createEpisodeWorkspace);
$("episodesBackButton").addEventListener("click", () => navigate("/"));
for (const button of document.querySelectorAll("[data-studio-route]")) {
  button.addEventListener("click", () => navigate(button.dataset.studioRoute));
}
$("saveSettingsButton").addEventListener("click", saveSettings);
$("loadPipelinesButton").addEventListener("click", loadPipelines);
$("newTargetButton").addEventListener("click", createAutopilotTarget);
$("deleteTargetButton").addEventListener("click", deleteCurrentAutopilotTarget);
$("addAccessButton").addEventListener("click", addAccess);
$("refreshDbButton").addEventListener("click", loadDbStatus);
$("exportDbButton").addEventListener("click", exportDbSnapshot);
$("importDbButton").addEventListener("click", stageUploadedDb);
$("clearImportButton").addEventListener("click", clearPendingImport);
$("autopilotTargetSelect").addEventListener("change", (event) => {
  void selectAutopilotTarget(event.target.value);
});
$("chatAutopilotSelect").addEventListener("change", (event) => {
  void selectAutopilotTarget(event.target.value);
});
$("pipelineSelect").addEventListener("change", () => {
  if ($("pipelineSelect").value) $("pipelineInput").value = $("pipelineSelect").value;
});
$("chatPipelineSelect").addEventListener("change", () => {
  state.activePipelineName = $("chatPipelineSelect").value || currentTarget()?.defaultPipeline || "";
  localStorage.setItem("snack_studio_pipeline", state.activePipelineName);
});
$("composer").addEventListener("submit", sendMessage);
$("messageInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});

window.addEventListener("popstate", () => {
  void renderRoute();
});

if (state.token) bootApp();
else showOnly("login");
