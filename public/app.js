import { derivePubkeyFromNsec, signEventWithNsec, signLoginChallengeWithNsec } from "/nostr-login.js";

const PROFILE_CACHE_KEY = "snack_studio_profiles_v2";
const PIPELINES_CACHE_KEY = "snack_studio_pipelines_v1";
const PROFILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CURRENT_SNACK_PROMPT_SUITE = "v3-intelligence-snacks-natural-prose";
const CURRENT_SNACK_PIPELINE_VERSION = "3";
const THEME_CATALOG = {
  'ai-coding': { name: 'AI Coding', colour: '#fe7141' },
  'ai-models-infrastructure': { name: 'AI Models & Infrastructure', colour: '#75c9c8' },
  'software-systems': { name: 'Software Systems', colour: '#cdabfe' },
  agents: { name: 'Agents', colour: '#d1ddd3' },
  'knowledge-memory': { name: 'Knowledge & Memory', colour: '#ef8fb1' },
  'privacy-security': { name: 'Privacy & Security', colour: '#d89b72' },
  'business-markets': { name: 'Business & Markets', colour: '#f4bf58' },
};
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
  workflows: [],
  workspaceOrigin: "/",
  activeEpisodeTab: 'overview',
  activeWorkflow: null,
  activeWork: null,
  activeEpisode: null,
  activeTranscript: null,
  publicTranscript: null,
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
  publicationPackage: null,
  websiteValidation: null,
  gitPublication: null,
  gitDeployment: null,
  contributorFormOpen: false,
  contributorPortraitJobs: {},
  contributors: [],
  activeContributor: null,
  contributorReturnTo: '/contributors',
  assets: [],
  assetFilter: 'all',
  diagnostics: [],
  diagnosticFilter: 'attention',
  thumbnailPollTimers: {},
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

function apiForm(path, formData, method = "POST") {
  return fetch(path, {
    method,
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
  if (!profileFullName(entry) && !entry.picture) return null;
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
  if (/^\/episodes\/[^/]+(?:\/(?:snacks|assets|publication))?$/.test(window.location.pathname)) return window.location.pathname;
  if (/^\/review(?:\/[^/]+)?$/.test(window.location.pathname)) return window.location.pathname;
  if (/^\/assets(?:\/[^/]+)?$/.test(window.location.pathname)) return window.location.pathname;
  if (window.location.pathname === '/library') return window.location.pathname;
  if (window.location.pathname === '/diagnostics') return window.location.pathname;
  if (/^\/publications(?:\/[^/]+)?$/.test(window.location.pathname)) return window.location.pathname;
  if (/^\/contributors(?:\/[^/]+)?$/.test(window.location.pathname)) return window.location.pathname;
  if (window.location.pathname === '/graph') return window.location.pathname;
  return "/";
}

function navigate(path) {
  const target = new URL(path, window.location.origin);
  if (`${window.location.pathname}${window.location.search}` !== `${target.pathname}${target.search}`) history.pushState({}, "", path);
  state.route = appRoute();
  void renderRoute();
}

function episodeTabUrl(tab = state.activeEpisodeTab, changes = {}) {
  const episodeId = state.activeEpisode?.id; if (!episodeId) return '/episodes';
  const suffix = tab === 'overview' ? '' : `/${tab}`;
  const url = new URL(`/episodes/${encodeURIComponent(episodeId)}${suffix}`, window.location.origin);
  const current = new URLSearchParams(window.location.search);
  for (const key of ['run','snack','mode','asset','contributor','gate','detail']) if (current.has(key)) url.searchParams.set(key, current.get(key));
  for (const [key, value] of Object.entries(changes)) value == null || value === '' ? url.searchParams.delete(key) : url.searchParams.set(key, String(value));
  return `${url.pathname}${url.search}`;
}

function replaceEpisodeTabState(changes) {
  const path = episodeTabUrl(state.activeEpisodeTab, changes); history.replaceState({}, '', path); state.route = appRoute();
}

function pushEpisodeTabState(changes) { navigate(episodeTabUrl(state.activeEpisodeTab, changes)); }
function pushEpisodeTabHistory(changes) { const path = episodeTabUrl(state.activeEpisodeTab, changes); history.pushState({}, '', path); state.route = appRoute(); }

function showOnly(id) {
  for (const sectionId of ["login", "home", "actPage", "shell"]) {
    $(sectionId).classList.toggle("hidden", sectionId !== id);
  }
}

function showStudioPage(id, breadcrumb) {
  for (const pageId of ["episodesPage", "episodePage", "reviewQueuePage", "assetReviewPage", "assetLibraryPage", "publicationsPage", "contributorsPage", "contributorPage", "graphPage", "diagnosticsPage", "studioSettingsPage"]) {
    $(pageId).classList.toggle("hidden", pageId !== id);
  }
  $("studioBreadcrumb").textContent = breadcrumb;
  for (const button of document.querySelectorAll("[data-studio-route]")) {
    const activeRoute = ['studioSettingsPage','diagnosticsPage'].includes(id) ? '/settings' : id === 'graphPage' ? '/graph' : ['assetLibraryPage','contributorsPage','contributorPage'].includes(id) ? '/library' : ['assetReviewPage','reviewQueuePage'].includes(id) ? '/review' : id === "publicationsPage" ? "/publications" : id === "episodePage" ? state.activeEpisodeTab === 'snacks' || state.activeEpisodeTab === 'assets' ? '/review' : state.activeEpisodeTab === 'publication' ? '/publications' : '/' : "/";
    button.classList.toggle("active", button.dataset.studioRoute === activeRoute);
  }
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function renderRoute() {
  document.querySelector('.candidateEditorDialog')?.remove();
  document.querySelector('.thumbnailReviewDialog')?.remove();
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

  if (state.route.startsWith('/review')) {
    showOnly('home'); await loadWorkflowRoute('review'); return;
  }
  if (state.route.startsWith('/assets')) { showOnly('home'); await loadWorkflowRoute('assets'); return; }
  if (state.route === '/library') { showOnly('home'); await loadAssetLibrary(); return; }
  if (state.route === '/diagnostics') { showOnly('home'); await loadDiagnostics(); return; }
  if (state.route.startsWith('/publications')) {
    showOnly('home'); await loadWorkflowRoute('publications'); return;
  }
  if (state.route.startsWith('/contributors')) { showOnly('home'); await loadContributorRoute(); return; }
  if (state.route === '/graph') { showOnly('home'); await loadGraph(); return; }

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
    img.addEventListener("error", () => {
      avatar.innerHTML = "";
      avatar.textContent = name.slice(0, 1).toUpperCase();
    }, { once: true });
    avatar.appendChild(img);
  } else {
    avatar.textContent = name.slice(0, 1).toUpperCase();
  }
}

async function resolveCurrentUserProfile() {
  try {
    const profile = await resolveProfile({ pubkey: state.me.pubkey, npub: state.me.npub });
    renderStudioUser(profile);
  } catch {
    renderStudioUser(null);
  }
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
  const match = state.route.match(/^\/episodes\/([^/]+)(?:\/(snacks|assets|publication))?$/);
  if (match) {
    const tab = match[2] || 'overview';
    await loadEpisode(decodeURIComponent(match[1]), { tab, stage: tab === 'snacks' ? 'output' : tab === 'assets' || tab === 'publication' ? 'publication' : undefined });
    return;
  }
  await loadEpisodes();
}

async function loadWorkflowRoute(kind) {
  const routePattern = kind === 'review' ? /^\/review\/([^/]+)$/ : kind === 'assets' ? /^\/assets\/([^/]+)$/ : /^\/publications\/([^/]+)$/;
  const match = state.route.match(routePattern);
  if (match) {
    const id = decodeURIComponent(match[1]); const tab = kind === 'review' ? 'snacks' : kind === 'assets' ? 'assets' : 'publication';
    navigate(`/episodes/${encodeURIComponent(id)}/${tab}`);
    return;
  }
  state.workspaceOrigin = kind === 'review' ? '/review' : kind === 'assets' ? '/assets' : '/publications';
  const page = kind === 'review' ? 'reviewQueuePage' : kind === 'assets' ? 'assetReviewPage' : 'publicationsPage';
  const label = kind === 'review' ? 'Review Queue' : kind === 'assets' ? 'Asset Review' : 'Publications';
  showStudioPage(page, `Snack Studio / ${label}`);
  setStudioStatus('Loading workflow…');
  try {
    const projection = kind === 'review' ? 'snacks' : kind === 'assets' ? 'assets' : 'publications';
    state.workflows = (await api(`/api/work/${projection}`)).episodes || [];
    renderWorkflowQueue(kind); setStudioStatus('Ready');
  } catch (error) { setStudioStatus(error.message); renderWorkflowQueue(kind, error.message); }
}

function renderWorkflowQueue(kind, errorMessage = '') {
  const container = $(kind === 'review' ? 'reviewQueue' : kind === 'assets' ? 'assetReviewQueue' : 'publicationsQueue'); container.innerHTML = '';
  const items = state.workflows;
  if (errorMessage || !items.length) {
    const empty = document.createElement('div'); empty.className = 'workflowQueueEmpty';
    const title = document.createElement('strong'); title.textContent = errorMessage ? 'The queue could not be loaded' : kind === 'review' ? 'Nothing needs review' : kind === 'assets' ? 'No assets need review' : 'No approved episodes are awaiting publication';
    const detail = document.createElement('span'); detail.textContent = errorMessage || (kind === 'review' ? 'New editorial decisions will appear here automatically.' : kind === 'assets' ? 'Contributor and artwork decisions will appear here automatically.' : 'Approve a final Snack set to begin publication preparation.');
    empty.append(title, detail); container.appendChild(empty); return;
  }
  for (const item of items) {
    const card = document.createElement('button'); card.type = 'button'; card.className = 'workflowQueueItem';
    const identity = document.createElement('div'); const eyebrow = document.createElement('span'); eyebrow.className = 'metadata'; eyebrow.textContent = item.episodeNumber ? `Episode ${item.episodeNumber}` : 'Episode number not set';
    const title = document.createElement('strong'); title.textContent = item.title; identity.append(eyebrow, title);
    const dimension = kind === 'review' ? item.snacks : kind === 'assets' ? item.assets : item.publication;
    const status = document.createElement('div'); const pill = document.createElement('span'); pill.className = `statusPill ${dimension.ready ? 'statusSuccess' : 'statusPending'}`; pill.textContent = formatEpisodeStatus(dimension.state);
    const action = document.createElement('span'); action.className = 'workflowQueueAction'; action.textContent = dimension.reasons?.[0] || (dimension.outstandingCount ? `${dimension.outstandingCount} outstanding` : 'Open episode'); status.append(pill, action);
    const tab = kind === 'review' ? 'snacks' : kind === 'assets' ? 'assets' : 'publication';
    card.append(identity, status); card.addEventListener('click', () => navigate(`/episodes/${encodeURIComponent(item.episodeId)}/${tab}`)); container.appendChild(card);
  }
}

async function loadContributorRoute() {
  const match = state.route.match(/^\/contributors\/([^/]+)$/);
  if (match) {
    const requestedReturn = new URLSearchParams(window.location.search).get('returnTo');
    state.contributorReturnTo = requestedReturn?.startsWith('/') ? requestedReturn : '/contributors';
    $('contributorsBackButton').textContent = /\/episodes\/[^/]+\/assets$/.test(state.contributorReturnTo) ? '← Asset Review' : '← All contributors';
    showStudioPage('contributorPage', 'Snack Studio / Contributors / Profile'); setStudioStatus('Loading contributor…');
    try {
      state.activeContributor = (await api(`/api/contributors/${encodeURIComponent(decodeURIComponent(match[1]))}`)).contributor;
      renderContributorWorkspace(state.activeContributor); setStudioStatus('Ready');
    } catch (error) { $('contributorWorkspace').textContent = error.message; setStudioStatus(error.message); }
    return;
  }
  showStudioPage('contributorsPage', 'Snack Studio / Contributors'); setStudioStatus('Loading contributors…');
  try { state.contributors = (await api('/api/contributors')).contributors || []; renderContributorLibrary(); setStudioStatus('Ready'); }
  catch (error) { $('contributorLibrary').textContent = error.message; setStudioStatus(error.message); }
}

async function loadAssetLibrary() {
  showStudioPage('assetLibraryPage', 'Snack Studio / Asset Library'); setStudioStatus('Loading assets…');
  try { state.assets = (await api('/api/assets')).assets || []; renderAssetLibrary(); setStudioStatus('Ready'); }
  catch (error) { $('assetLibraryGrid').textContent = error.message; setStudioStatus(error.message); }
}

async function loadDiagnostics() {
  showStudioPage('diagnosticsPage', 'Snack Studio / Diagnostics'); setStudioStatus('Loading diagnostics…');
  try {
    state.diagnostics = (await api('/api/diagnostics')).items || [];
    if (new URLSearchParams(window.location.search).has('episode')) state.diagnosticFilter = `episode:${new URLSearchParams(window.location.search).get('episode')}`;
    renderDiagnostics(); setStudioStatus('Ready');
  } catch (error) { $('diagnosticList').textContent = error.message; setStudioStatus(error.message); }
}

function diagnosticNeedsAttention(item) { return ['failed','timed-out','needs-review','cancelled','error'].includes(item.status); }

function renderDiagnostics() {
  const summary = $('diagnosticSummary'); const filters = $('diagnosticFilters'); const list = $('diagnosticList'); summary.innerHTML = ''; filters.innerHTML = ''; list.innerHTML = '';
  const active = state.diagnostics.filter((item) => ['created','prepared','awaiting-authorization','queued','running','applying-result','extracting','grounding','generating'].includes(item.status)).length;
  const attention = state.diagnostics.filter(diagnosticNeedsAttention).length;
  for (const [label, value] of [['Needs attention', attention], ['Running', active], ['Recorded jobs', state.diagnostics.length]]) { const card = document.createElement('article'); card.className = 'card cardCompact'; const name = document.createElement('span'); name.textContent = label; const count = document.createElement('strong'); count.className = 'num'; count.textContent = String(value); card.append(name, count); summary.appendChild(card); }
  const episodeFilter = state.diagnosticFilter.startsWith('episode:');
  for (const [value, label] of [['attention','Needs attention'],['active','Running'],['all','All history']]) { const button = document.createElement('button'); button.type = 'button'; button.className = `btn btnSecondary${state.diagnosticFilter === value ? ' active' : ''}`; button.textContent = label; button.addEventListener('click', () => { state.diagnosticFilter = value; history.replaceState({}, '', '/diagnostics'); renderDiagnostics(); }); filters.appendChild(button); }
  if (episodeFilter) { const item = state.diagnostics.find((entry) => entry.episodeId === state.diagnosticFilter.slice(8)); const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btnSecondary active'; button.textContent = item?.episodeNumber ? `Episode ${item.episodeNumber}` : 'Selected episode'; button.addEventListener('click', () => { state.diagnosticFilter = 'all'; history.replaceState({}, '', '/diagnostics'); renderDiagnostics(); }); filters.appendChild(button); }
  const items = state.diagnostics.filter((item) => state.diagnosticFilter === 'all' ? true : state.diagnosticFilter === 'attention' ? diagnosticNeedsAttention(item) : state.diagnosticFilter === 'active' ? ['created','prepared','awaiting-authorization','queued','running','applying-result','extracting','grounding','generating'].includes(item.status) : item.episodeId === state.diagnosticFilter.slice(8));
  if (!items.length) { const empty = document.createElement('div'); empty.className = 'workflowQueueEmpty'; empty.innerHTML = `<strong>${state.diagnosticFilter === 'attention' ? 'Nothing needs attention' : 'No matching jobs'}</strong><span>${state.diagnosticFilter === 'attention' ? 'Failed or interrupted work will appear here.' : 'Try another filter.'}</span>`; list.appendChild(empty); return; }
  for (const item of items) {
    const row = document.createElement('article'); row.className = `diagnosticItem${diagnosticNeedsAttention(item) ? ' needsAttention' : ''}`;
    const copy = document.createElement('div'); const kind = document.createElement('span'); kind.className = 'metadata'; kind.textContent = item.kind === 'pipeline' ? 'Text pipeline' : item.kind === 'thumbnail' ? 'Artwork pipeline' : 'Portrait pipeline'; const title = document.createElement('strong'); title.textContent = formatEpisodeStatus(item.label); const context = document.createElement('span'); context.textContent = item.episodeTitle ? `${item.episodeNumber ? `Episode ${item.episodeNumber} · ` : ''}${item.episodeTitle}` : item.contributorName || 'Contributor'; copy.append(kind, title, context);
    if (item.failureSummary) { const failure = document.createElement('p'); failure.className = 'pipelineRequestFailure'; failure.textContent = item.failureSummary; copy.appendChild(failure); }
    const facts = document.createElement('div'); facts.className = 'diagnosticFacts'; const status = document.createElement('span'); status.className = `statusPill ${statusClass(item.status)}`; status.textContent = formatEpisodeStatus(item.status); const time = document.createElement('span'); time.className = 'metadata'; time.textContent = formatActivity(item.updatedAt); facts.append(status, time);
    const open = document.createElement('button'); open.type = 'button'; open.className = 'btn btnSecondary'; open.textContent = diagnosticNeedsAttention(item) ? 'Open recovery' : 'Open context'; open.addEventListener('click', () => navigate(item.kind === 'portrait' ? `/contributors/${encodeURIComponent(item.contributorId)}` : item.kind === 'thumbnail' ? `/episodes/${encodeURIComponent(item.episodeId)}/assets` : `/episodes/${encodeURIComponent(item.episodeId)}`)); facts.appendChild(open);
    row.append(copy, facts); list.appendChild(row);
  }
}

function renderAssetLibrary() {
  const filters = $('assetLibraryFilters'); const grid = $('assetLibraryGrid'); filters.innerHTML = ''; grid.innerHTML = '';
  const kinds = [['all', 'All'], ['snack', 'Snack thumbnails'], ['episode', 'Episode thumbnails'], ['portrait', 'Contributor portraits']];
  for (const [value, label] of kinds) {
    const count = value === 'all' ? state.assets.length : state.assets.filter((asset) => asset.assetKind === value).length;
    const button = document.createElement('button'); button.type = 'button'; button.className = `btn btnSecondary${state.assetFilter === value ? ' active' : ''}`; button.textContent = `${label} · ${count}`;
    button.addEventListener('click', () => { state.assetFilter = value; renderAssetLibrary(); }); filters.appendChild(button);
  }
  const assets = state.assetFilter === 'all' ? state.assets : state.assets.filter((asset) => asset.assetKind === state.assetFilter);
  if (!assets.length) { const empty = document.createElement('div'); empty.className = 'workflowQueueEmpty'; empty.innerHTML = '<strong>No finished assets here yet</strong><span>Assets appear here permanently after approval.</span>'; grid.appendChild(empty); return; }
  for (const asset of assets) {
    const card = document.createElement('article'); card.className = `assetLibraryCard assetKind-${asset.assetKind}`;
    const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'assetLibraryPreview'; preview.setAttribute('aria-label', `Open ${asset.title}`);
    if (asset.assetKind === 'portrait') { const image = document.createElement('img'); image.src = asset.imageUrl; image.alt = ''; preview.appendChild(image); }
    else loadPrivateImage(asset.imageUrl, preview, asset.title);
    preview.addEventListener('click', () => navigate(asset.assetKind === 'portrait' ? `/contributors/${encodeURIComponent(asset.contributorId)}` : `/episodes/${encodeURIComponent(asset.episodeId)}/assets`));
    const copy = document.createElement('div'); copy.className = 'assetLibraryCopy'; const kind = document.createElement('span'); kind.className = 'metadata'; kind.textContent = asset.assetKind === 'portrait' ? 'Contributor portrait' : asset.assetKind === 'episode' ? `Episode ${asset.episodeNumber || ''} thumbnail` : `Episode ${asset.episodeNumber || ''} · Snack thumbnail`;
    const title = document.createElement('strong'); title.textContent = asset.title; const subtitle = document.createElement('span'); subtitle.textContent = asset.subtitle || (asset.assetKind === 'snack' ? asset.episodeTitle : `${asset.width} × ${asset.height} · Version ${asset.versionNumber}`);
    copy.append(kind, title, subtitle); card.append(preview, copy); grid.appendChild(card);
  }
}

function renderContributorLibrary() {
  const library = $('contributorLibrary'); library.innerHTML = '';
  if (!state.contributors.length) { const empty = document.createElement('div'); empty.className = 'workflowQueueEmpty'; empty.innerHTML = '<strong>No contributors yet</strong><span>Contributors resolved from episodes will appear here permanently.</span>'; library.appendChild(empty); return; }
  for (const contributor of state.contributors) {
    const card = document.createElement('button'); card.type = 'button'; card.className = 'contributorLibraryCard';
    const image = document.createElement('div'); image.className = 'contributorLibraryPortrait';
    if (contributor.portraitPath) { const img = document.createElement('img'); img.src = contributor.portraitPath; img.alt = ''; image.appendChild(img); }
    else image.textContent = contributor.name.slice(0, 1).toUpperCase();
    const copy = document.createElement('div'); const name = document.createElement('strong'); name.textContent = contributor.name;
    const role = document.createElement('span'); role.textContent = contributor.role; const status = document.createElement('span'); status.className = `statusPill ${contributor.portraitStatus === 'approved' ? 'statusSuccess' : 'statusPending'}`; status.textContent = contributor.portraitStatus === 'approved' ? 'Portrait approved' : formatEpisodeStatus(contributor.portraitStatus);
    copy.append(name, role, status); card.append(image, copy); card.addEventListener('click', () => navigate(`/contributors/${encodeURIComponent(contributor.id)}`)); library.appendChild(card);
  }
}

function contributorFormField(form, name, labelText, value, kind = 'input') {
  const label = document.createElement('label'); label.className = 'workspaceField'; const title = document.createElement('span'); title.textContent = labelText;
  const input = document.createElement(kind === 'textarea' ? 'textarea' : 'input'); input.name = name; if (kind === 'textarea') input.rows = 5; else input.type = name.endsWith('Url') ? 'url' : 'text'; input.value = value || ''; input.disabled = !state.me?.access?.edit;
  label.append(title, input); form.appendChild(label); return input;
}

function renderContributorWorkspace(contributor) {
  const workspace = $('contributorWorkspace'); workspace.innerHTML = '';
  const header = document.createElement('header'); header.className = 'contributorWorkspaceHeader';
  const portrait = document.createElement('div'); portrait.className = 'contributorWorkspacePortrait';
  if (contributor.portraitPath) { const img = document.createElement('img'); img.src = contributor.portraitPath; img.alt = `${contributor.name} approved portrait`; portrait.appendChild(img); } else portrait.textContent = contributor.name.slice(0, 1).toUpperCase();
  const identity = document.createElement('div'); const eyebrow = document.createElement('p'); eyebrow.className = 'eyebrow'; eyebrow.textContent = contributor.source === 'website' ? 'Website contributor' : 'Studio contributor'; const title = document.createElement('h1'); title.textContent = contributor.name; const role = document.createElement('p'); role.textContent = contributor.role; identity.append(eyebrow, title, role);
  const status = document.createElement('span'); status.className = `statusPill ${contributor.portraitStatus === 'approved' ? 'statusSuccess' : 'statusPending'}`; status.textContent = contributor.portraitStatus === 'approved' ? 'Portrait approved' : formatEpisodeStatus(contributor.portraitStatus);
  const headerActions = document.createElement('div'); headerActions.className = 'contributorWorkspaceHeaderActions'; headerActions.appendChild(status);
  if (contributor.portraitPath) {
    const removePortrait = document.createElement('button'); removePortrait.type = 'button'; removePortrait.className = 'btn btnSecondary'; removePortrait.textContent = 'Remove portrait'; removePortrait.disabled = !state.me?.access?.edit;
    removePortrait.addEventListener('click', async () => {
      if (!window.confirm(`Remove ${contributor.name}'s approved portrait? Thumbnail approvals using this portrait will return to draft until they are regenerated.`)) return;
      const clear = setButtonBusy(removePortrait, 'Removing…');
      try { state.activeContributor = (await api(`/api/contributors/${encodeURIComponent(contributor.id)}/portrait`, { method: 'DELETE' })).contributor; renderContributorWorkspace(state.activeContributor); setStudioStatus('Portrait removed · ready to regenerate'); }
      catch (error) { setStudioStatus(error.message); clear(); }
    });
    headerActions.appendChild(removePortrait);
  }
  header.append(portrait, identity, headerActions); workspace.appendChild(header);

  const form = document.createElement('form'); form.className = 'contributorEditForm';
  const formHeader = document.createElement('div'); formHeader.className = 'workspaceSectionHeader'; formHeader.innerHTML = '<div><h2>Public profile</h2><p>These details and identity assets persist across every episode.</p></div>';
  const save = document.createElement('button'); save.type = 'submit'; save.className = 'btn btnPrimary'; save.textContent = 'Save profile'; save.disabled = !state.me?.access?.edit; formHeader.appendChild(save); form.appendChild(formHeader);
  const grid = document.createElement('div'); grid.className = 'contributorProfileFields'; form.appendChild(grid);
  contributorFormField(grid, 'name', 'Name', contributor.name); contributorFormField(grid, 'role', 'Role', contributor.role); contributorFormField(grid, 'shortBio', 'Short bio', contributor.shortBio);
  contributorFormField(grid, 'aliases', 'Transcript aliases', contributor.aliases.join(', ')); contributorFormField(grid, 'externalUrl', 'Website', contributor.externalUrl); contributorFormField(grid, 'xUrl', 'X profile', contributor.xUrl); contributorFormField(grid, 'linkedinUrl', 'LinkedIn profile', contributor.linkedinUrl); contributorFormField(grid, 'nostrUrl', 'Nostr profile', contributor.nostrUrl);
  contributorFormField(form, 'biographyMarkdown', 'Biography', contributor.biographyMarkdown, 'textarea');
  const photoField = document.createElement('label'); photoField.className = 'contributorIdentitySource'; const photoCopy = document.createElement('div'); photoCopy.innerHTML = '<strong>Identity source photo</strong><span>Replace this photo before generating a new voxel portrait.</span>';
  const sourcePreview = document.createElement('div'); sourcePreview.className = 'contributorSourcePreview'; if (contributor.referencePhotoPath) loadPrivateImage(contributor.referencePhotoPath, sourcePreview, `${contributor.name} identity source`);
  const photo = document.createElement('input'); photo.type = 'file'; photo.name = 'photo'; photo.accept = 'image/jpeg,image/png,image/webp'; photo.disabled = !state.me?.access?.edit; photoField.append(photoCopy, sourcePreview, photo); form.appendChild(photoField);
  form.addEventListener('submit', async (event) => { event.preventDefault(); const clear = setButtonBusy(save, 'Saving…'); try { state.activeContributor = (await apiForm(`/api/contributors/${encodeURIComponent(contributor.id)}`, new FormData(form), 'PATCH')).contributor; renderContributorWorkspace(state.activeContributor); setStudioStatus('Contributor profile saved'); } catch (error) { setStudioStatus(error.message); } finally { clear(); } });
  workspace.appendChild(form);
  workspace.appendChild(renderContributorPortraitWorkflow({ contributorId: contributor.id, name: contributor.name, portraitStatus: contributor.portraitStatus }));
}

function loadPrivateImage(url, container, alt) {
  fetch(url, { headers: state.token ? { authorization: `Bearer ${state.token}` } : {} }).then((response) => response.ok ? response.blob() : Promise.reject(new Error('Image unavailable'))).then((blob) => { const image = document.createElement('img'); image.src = URL.createObjectURL(blob); image.alt = alt; container.replaceChildren(image); }).catch(() => { container.textContent = 'Source photo unavailable'; });
}

async function refreshContributorDetail(contributorId) {
  state.activeContributor = (await api(`/api/contributors/${encodeURIComponent(contributorId)}`)).contributor;
  renderContributorWorkspace(state.activeContributor);
}

async function loadGraph() {
  showStudioPage('graphPage', 'Snack Studio / Graph'); setStudioStatus('Loading graph…');
  try { const payload = await api('/api/graph'); renderGraph(payload); setStudioStatus('Ready'); } catch (error) { $('graphWorkspace').textContent = error.message; setStudioStatus(error.message); }
}

function renderGraph(payload) {
  const container = $('graphWorkspace'); container.innerHTML = '';
  const relationships = payload.relationships || [];
  if (!relationships.length) { const empty = document.createElement('div'); empty.className = 'workflowQueueEmpty'; empty.innerHTML = '<strong>No relationship suggestions yet</strong><span>Grounded suggestions are created automatically as approved episodes enter Publications.</span>'; container.appendChild(empty); return; }
  for (const relationship of relationships) {
    const row = document.createElement('article'); row.className = 'workflowQueueItem graphRelationship';
    const copy = document.createElement('div'); const title = document.createElement('strong'); title.textContent = `${relationship.sourceTitle} → ${formatEpisodeStatus(relationship.relationshipType)} → ${relationship.targetTitle}`;
    const note = document.createElement('span'); note.textContent = relationship.explanation || 'No explanation supplied'; copy.append(title, note);
    if (relationship.evidenceExcerpt) { const evidence = document.createElement('span'); evidence.className = 'metadata'; evidence.textContent = `Evidence: ${relationship.evidenceExcerpt}`; copy.appendChild(evidence); }
    const actions = document.createElement('div'); const pill = document.createElement('span'); pill.className = `statusPill ${relationship.reviewState === 'approved' ? 'statusSuccess' : relationship.reviewState === 'rejected' ? 'statusDanger' : 'statusPending'}`; pill.textContent = formatEpisodeStatus(relationship.reviewState); actions.appendChild(pill);
    if (relationship.reviewState === 'draft') for (const [reviewState, label] of [['approved','Approve'],['rejected','Reject']]) { const button = document.createElement('button'); button.type = 'button'; button.className = reviewState === 'approved' ? 'btn btnPrimary' : 'btn btnSecondary'; button.textContent = label; button.addEventListener('click', async () => { await api(`/api/relationships/${encodeURIComponent(relationship.id)}`, { method: 'PATCH', body: JSON.stringify({ reviewState }) }); await loadGraph(); }); actions.appendChild(button); }
    row.append(copy, actions); container.appendChild(row);
  }
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
    const row = document.createElement("div");
    row.className = "episodeRow";
    row.tabIndex = 0; row.setAttribute('role', 'link');
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
    const menu = document.createElement('details'); menu.className = 'episodeRowMenu';
    const trigger = document.createElement('summary'); trigger.setAttribute('aria-label', `Options for ${episode.workingTitle}`); trigger.textContent = '⋮';
    const options = document.createElement('div');
    const open = document.createElement('button'); open.type = 'button'; open.textContent = 'Open details'; open.addEventListener('click', (event) => { event.stopPropagation(); navigate(`/episodes/${encodeURIComponent(episode.id)}`); });
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'danger'; remove.textContent = 'Delete workspace'; remove.disabled = !state.me?.access?.edit; remove.addEventListener('click', (event) => { event.stopPropagation(); void deleteEpisodeWorkspace(episode); });
    options.append(open, remove); menu.append(trigger, options);
    row.append(identity, status, updated, menu);
    row.addEventListener("click", (event) => { if (!event.target.closest('.episodeRowMenu')) navigate(`/episodes/${encodeURIComponent(episode.id)}`); });
    row.addEventListener('keydown', (event) => { if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('.episodeRowMenu')) navigate(`/episodes/${encodeURIComponent(episode.id)}`); });
    list.appendChild(row);
  }
}

async function loadEpisode(id, options = {}) {
  document.querySelector('.candidateEditorDialog')?.remove();
  state.activeEpisodeTab = options.tab || (state.activeEpisode?.id === id ? state.activeEpisodeTab : 'overview');
  state.workspaceOrigin = state.activeEpisodeTab === 'snacks' ? '/review' : state.activeEpisodeTab === 'assets' ? '/assets' : state.activeEpisodeTab === 'publication' ? '/publications' : '/';
  $('episodesBackButton').textContent = state.activeEpisodeTab === 'snacks' ? '← Snack Review' : state.activeEpisodeTab === 'assets' ? '← Asset Review' : state.activeEpisodeTab === 'publication' ? '← Publications' : '← All episodes';
  showStudioPage("episodePage", `Snack Studio / Episodes / ${state.activeEpisodeTab === 'overview' ? 'Overview' : state.activeEpisodeTab[0].toUpperCase() + state.activeEpisodeTab.slice(1)}`);
  setStudioStatus("Loading workspace…");
  try {
    const [payload, candidatePayload, curationPayload, pipelinePayload, publicationPayload, packagePayload, validationPayload, gitPublicationPayload, gitDeploymentPayload, workPayload, publicTranscriptPayload] = await Promise.all([
      api(`/api/episodes/${encodeURIComponent(id)}`),
      api(`/api/episodes/${encodeURIComponent(id)}/candidates`),
      api(`/api/episodes/${encodeURIComponent(id)}/curation`),
      api(`/api/episodes/${encodeURIComponent(id)}/pipeline-requests`),
      api(`/api/episodes/${encodeURIComponent(id)}/publication-preparation`).catch(() => ({ preparation: null })),
      api(`/api/episodes/${encodeURIComponent(id)}/publication-package`).catch(() => ({ package: null })),
      api(`/api/episodes/${encodeURIComponent(id)}/website-validation`).catch(() => ({ validation: null })),
      api(`/api/episodes/${encodeURIComponent(id)}/git-publication`).catch(() => ({ publication: null })),
      api(`/api/episodes/${encodeURIComponent(id)}/git-deployment`).catch(() => ({ deployment: null })),
      api(`/api/episodes/${encodeURIComponent(id)}/work`).catch(() => ({ work: null })),
      api(`/api/episodes/${encodeURIComponent(id)}/public-transcript`).catch(() => ({ publicTranscript: null })),
    ]);
    state.activeEpisode = payload.episode;
    state.activeTranscript = payload.transcript || null;
    state.publicTranscript = publicTranscriptPayload.publicTranscript || null;
    state.transcriptRevisions = payload.transcriptRevisions || [];
    state.candidates = candidatePayload.candidates || [];
    state.candidateGenerations = candidateGenerations(state.candidates, candidatePayload.generations);
    state.approvedBatch = candidatePayload.approvedBatch || { ready: false, checks: [], candidateIds: [] };
    state.regenerationProposals = candidatePayload.regenerationProposals || {};
    if (state.activeEpisodeTab === 'snacks') {
      const query = new URLSearchParams(window.location.search);
      const requestedRun = query.get('run'); const requestedSnack = query.get('snack');
      state.activeGenerationId = requestedRun === 'approved' || state.candidateGenerations.some((item) => item.id === requestedRun) ? requestedRun : state.candidateGenerations.at(-1)?.id || '';
      state.activeCandidateId = state.candidates.some((item) => item.id === requestedSnack) ? requestedSnack : '';
    }
    if (!hasCandidateGeneration(state.activeGenerationId)) {
      state.activeGenerationId = state.candidateGenerations.at(-1)?.id || "";
      state.activeCandidateId = "";
    }
    state.curation = curationPayload;
    state.pipelineRequests = pipelinePayload.pipelineRequests || [];
    state.pipelineTimeoutMs = Number(pipelinePayload.timeoutMs || 0);
    state.episodeAuditEvents = payload.auditEvents || [];
    state.publicationPreparation = publicationPayload.preparation || null;
    state.publicationPackage = packagePayload.package || null;
    state.websiteValidation = validationPayload.validation || null;
    state.gitPublication = gitPublicationPayload.publication || null;
    state.gitDeployment = gitDeploymentPayload.deployment || null;
    state.activeWork = workPayload.work || null;
    state.activeWorkflow = null;
    if (!state.episodeStage || state.episodeStageId !== id) {
      state.episodeStage = episodeWorkspaceStage();
      state.episodeStageId = id;
    }
    if (options.stage) state.episodeStage = options.stage;
    if (state.candidates.length && state.episodeStage === "processing") state.episodeStage = "output";
    renderEpisodeWorkspace(payload.episode, payload.transcript, payload.transcriptRevisions || [], payload.auditEvents || [], state.candidates);
    if (['assets','publication'].includes(state.activeEpisodeTab) && ['approved','published'].includes(state.activeEpisode.status) && !state.publicationPreparation?.jobs?.length) await preparePublication();
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
  headerActions.append(status);
  if (state.workspaceOrigin === '/') headerActions.appendChild(detailsButton);
  header.appendChild(headerActions);

  const destinations = document.createElement('nav'); destinations.className = 'sectionTabs episodeWorkspaceDestinations'; destinations.setAttribute('aria-label', 'Episode sections');
  for (const [route, label, available, unavailableReason] of [
    [`/episodes/${episode.id}`, 'Overview', true, ''],
    [`/episodes/${episode.id}/snacks`, 'Snacks', Boolean(candidates.length), 'Snacks will appear after generation finishes.'],
    [`/episodes/${episode.id}/assets`, 'Assets', ['approved','published'].includes(episode.status), 'Approve the final Snack set before preparing assets.'],
    [`/episodes/${episode.id}/publication`, 'Publication', ['approved','published'].includes(episode.status), 'Approve the final Snack set before preparing publication.'],
  ]) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    const tab = route.endsWith('/snacks') ? 'snacks' : route.endsWith('/assets') ? 'assets' : route.endsWith('/publication') ? 'publication' : 'overview';
    if (state.activeEpisodeTab === tab) button.classList.add('active');
    button.disabled = !available; if (!available) button.title = unavailableReason;
    button.addEventListener('click', () => navigate(route)); destinations.appendChild(button);
  }

  // The canonical episode destinations are separate work surfaces. Render the
  // selected surface directly instead of constructing the legacy all-in-one
  // workflow and hiding most of it afterwards.
  if (state.activeEpisodeTab === 'snacks') {
    workspace.append(header, destinations, renderCandidateSection(episode, candidates));
    return;
  }
  if (state.activeEpisodeTab === 'assets') {
    workspace.append(header, destinations, renderPublicationPreparation(episode, candidates, { assetsOnly: true }));
    return;
  }
  if (state.activeEpisodeTab === 'publication') {
    workspace.append(header, destinations, renderPublicationPreparation(episode, candidates));
    return;
  }

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
  metadataHeader.innerHTML = "<div><h2>Episode details</h2><p>Only source details that cannot be reliably inferred belong here.</p></div>";
  const metadataSave = document.createElement("button");
  metadataSave.type = "submit";
  metadataSave.className = "btn btnPrimary";
  metadataSave.textContent = "Save changes";
  metadataSave.hidden = true;
  metadataSave.disabled = true;
  metadataHeader.appendChild(metadataSave);
  const fields = document.createElement("div");
  fields.className = "workspaceFieldGrid";
  fields.append(
    makeWorkspaceField("Episode number", workspaceInput("workspaceEpisodeNumber", "number", episode.episodeNumber)),
    makeWorkspaceField("Episode title", workspaceInput("workspaceWorkingTitle", "text", episode.workingTitle)),
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
  metadataForm.addEventListener('input', () => { metadataSave.hidden = false; metadataSave.disabled = !state.me?.access?.edit; });

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
  const transcriptDetails = document.createElement('section'); transcriptDetails.className = 'workspaceSection transcriptDetailsSummary';
  const transcriptDetailsHeader = document.createElement('div'); transcriptDetailsHeader.className = 'workspaceSectionHeader';
  transcriptDetailsHeader.innerHTML = `<div><h2>Transcript source</h2><p>${transcript ? `${transcript.originalFilename || 'Pasted transcript'} · revision ${transcript.revisionNumber} · ${Math.round(transcript.sizeBytes / 1024)} KB` : 'No transcript uploaded'}</p></div>`;
  const transcriptNote = document.createElement('p'); transcriptNote.className = 'metadata'; transcriptNote.textContent = 'The source transcript is preserved unchanged. A separate cleanup step for the public website transcript is planned for the publishing flow and has not yet been implemented.';
  transcriptDetails.append(transcriptDetailsHeader, transcriptNote);
  detailsStage.append(metadataForm, transcriptDetails, history);
  workspace.append(header, destinations, state.episodeStage === 'details' ? detailsStage : transcript ? renderEpisodeOverview(episode, transcript, candidates, processingStage) : setupStage);
}

function renderEpisodeOverview(episode, transcript, candidates, processingStage) {
  const overview = document.createElement('section'); overview.className = 'episodeOverview';
  const work = state.activeWork;
  if (work?.source?.state === 'generating' && !candidates.length) { overview.appendChild(processingStage); return overview; }
  const statusCard = document.createElement('div'); statusCard.className = 'episodeOverviewStatus';
  const copy = document.createElement('div'); const eyebrow = document.createElement('p'); eyebrow.className = 'eyebrow'; eyebrow.textContent = 'Current stage';
  const title = document.createElement('h2'); title.textContent = work?.publication?.deployed ? 'Episode deployed' : work?.recommendedAction?.label || formatEpisodeStatus(episode.status);
  const detail = document.createElement('p'); detail.textContent = work?.publication?.deployed ? 'This episode has completed the Studio workflow.' : 'Each area remains independently accessible while other work continues.';
  copy.append(eyebrow, title, detail);
  if (work?.recommendedAction) {
    const action = document.createElement('button'); action.type = 'button'; action.className = 'btn btnPrimary'; action.textContent = work.recommendedAction.label;
    action.addEventListener('click', () => {
      if (work.recommendedAction.route === 'snacks') navigate(`/episodes/${encodeURIComponent(episode.id)}/snacks`);
      else if (work.recommendedAction.route === 'assets') navigate(`/episodes/${encodeURIComponent(episode.id)}/assets`);
      else if (work.recommendedAction.route === 'publication') navigate(`/episodes/${encodeURIComponent(episode.id)}/publication`);
      else if (work.source.state === 'needs-attention') void startEpisodeExtraction();
    });
    statusCard.append(copy, action);
  } else statusCard.appendChild(copy);
  const facts = document.createElement('div'); facts.className = 'episodeOverviewFacts';
  for (const [label, value] of [
    ['Transcript', `${transcript.originalFilename || 'Pasted transcript'} · revision ${transcript.revisionNumber}`],
    ['Generated Snacks', String(candidates.length)],
    ['Approved Snacks', String(candidates.filter((candidate) => candidate.reviewDecision === 'accepted').length)],
    ['Publication', formatEpisodeStatus(work?.publication?.state || 'not-started')],
  ]) {
    const fact = document.createElement('div'); const name = document.createElement('span'); name.textContent = label; const valueNode = document.createElement('strong'); valueNode.textContent = value; fact.append(name, valueNode); facts.appendChild(fact);
  }
  overview.append(statusCard, facts); return overview;
}

function renderPublicationPreparation(episode, candidates, options = {}) {
  const assetsOnly = options.assetsOnly === true;
  const section = document.createElement("section");
  section.className = "publicationPreparation";
  const header = document.createElement("header");
  header.className = "publicationPreparationHeader";
  const copy = document.createElement("div");
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow metadata";
  eyebrow.textContent = assetsOnly ? "Asset review" : "Publishing";
  const title = document.createElement("h2");
  title.textContent = assetsOnly ? "Review contributors and artwork" : "Prepare episode package";
  const help = document.createElement("p");
  help.textContent = assetsOnly ? "Everything requiring a visual or identity decision remains available here, including approved items and replacement controls." : "Snack Studio is assembling the website package while visual decisions remain in Asset Review.";
  copy.append(eyebrow, title, help);
  header.append(copy);
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
  const topicRequest = state.pipelineRequests.find((request) => request.operation === "publication-metadata");
  const topicsRunning = topicRequest && ["created", "awaiting-authorization", "queued", "running", "applying-result"].includes(topicRequest.status);
  const snackJobs = (preparation.jobs || []).filter((job) => job.assetKind === 'snack');
  const episodeJob = (preparation.jobs || []).find((job) => job.assetKind === 'episode');
  for (const [label, value, stateClass] of [
    ["Approved Snacks", String(snackJobs.length), ""],
    ["Contributor portraits", `${resolved.length} resolved`, unresolved.length ? "statusWarning" : "statusSuccess"],
    ["Episode themes", topicsRunning ? "Resolving…" : topicsMissing.length ? "Derivation needed" : "Resolved", topicsRunning || topicsMissing.length ? "statusWarning" : "statusSuccess"],
  ]) {
    const item = document.createElement("div");
    const name = document.createElement("span"); name.textContent = label;
    const valueNode = document.createElement("strong"); valueNode.textContent = value;
    if (stateClass) valueNode.className = `statusPill ${stateClass}`;
    item.append(name, valueNode); facts.appendChild(item);
  }
  section.appendChild(facts);
  if (topicRequest && ['failed', 'needs-input'].includes(topicRequest.status) && topicsMissing.length) {
    const retryPanel = document.createElement('div'); retryPanel.className = 'publicationPreparationBlocker';
    const retryCopy = document.createElement('p'); retryCopy.textContent = topicRequest.failureSummary || 'Automatic theme derivation needs another attempt.';
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn btnSecondary'; retry.textContent = 'Retry theme assessment'; retry.disabled = !state.me?.access?.edit;
    retry.addEventListener('click', () => retryPipelineRequest(topicRequest.id));
    retryPanel.append(retryCopy, retry); section.appendChild(retryPanel);
  }
  if (!assetsOnly) {
    const transcriptWorkflow = renderPublicTranscriptWorkflow(); transcriptWorkflow.dataset.publicationGate = 'transcript';
    const newsletterWorkflow = renderNewsletterWorkflow(candidates); newsletterWorkflow.dataset.publicationGate = 'newsletter';
    section.append(transcriptWorkflow, newsletterWorkflow);
  }
  if (preparation.themes?.length) {
    const themeList = document.createElement('div'); themeList.className = 'episodeThemeList';
    for (const theme of preparation.themes) { const item = document.createElement('span'); const swatch = document.createElement('i'); swatch.className = 'topicSwatch'; swatch.style.backgroundColor = theme.colour; item.append(swatch, theme.name); item.title = theme.description; themeList.appendChild(item); }
    section.appendChild(themeList);
  }
  if (!assetsOnly) {
    const assetSummary = document.createElement('div'); assetSummary.className = 'publicationPreparationBlocker';
    const assetCopy = document.createElement('p');
    const unfinished = [...snackJobs, ...(episodeJob ? [episodeJob] : [])].filter((job) => job.status !== 'approved').length + portraitsNeededCount(preparation) + unresolved.length;
    assetCopy.textContent = unfinished ? `${unfinished} contributor or artwork decision${unfinished === 1 ? '' : 's'} remain in Asset Review.` : 'Contributor identities and finished artwork are approved.';
    const openAssets = document.createElement('button'); openAssets.type = 'button'; openAssets.className = 'btn btnSecondary'; openAssets.textContent = unfinished ? 'Open Asset Review' : 'View approved assets'; openAssets.addEventListener('click', () => navigate(`/episodes/${encodeURIComponent(episode.id)}/assets`));
    assetSummary.append(assetCopy, openAssets); section.appendChild(assetSummary);
    if (state.publicationPackage) section.appendChild(renderPublicationPackageManifest(state.publicationPackage));
    const requestedGate = new URLSearchParams(window.location.search).get('gate');
    if (requestedGate) queueMicrotask(() => {
      const target = section.querySelector(`[data-publication-gate="${CSS.escape(requestedGate)}"]`);
      target?.classList.add('assetRowFocused'); target?.scrollIntoView({ block: 'center' });
    });
    return section;
  }
  if (unresolved.length) {
    const blocker = document.createElement("div");
    blocker.className = "publicationPreparationBlocker";
    const message = document.createElement("p");
    message.textContent = `New contributor profile required for ${unresolved.join(", ")}.`;
    const create = document.createElement("button");
    create.type = "button";
    create.className = "btn btnSecondary";
    create.textContent = "Create contributor";
    create.disabled = !state.me?.access?.edit;
    create.addEventListener("click", () => {
      state.contributorFormOpen = true;
      renderEpisodeWorkspace(state.activeEpisode, state.activeTranscript, state.transcriptRevisions, state.episodeAuditEvents, state.candidates);
    });
    blocker.append(message, create);
    section.appendChild(blocker);
    if (state.contributorFormOpen) section.appendChild(renderContributorForm(unresolved[0]));
  }
  const portraitsNeeded = preparation.contributorsNeedingPortraits || [];
  if (portraitsNeeded.length) {
    for (const item of portraitsNeeded) section.appendChild(renderContributorPortraitWorkflow(item));
  }
  if (episodeJob) section.appendChild(renderEpisodeThumbnailWorkflow(episode, episodeJob, resolved, portraitsNeeded));
  const queue = document.createElement("div");
  queue.className = "publicationThumbnailQueue";
  for (const job of snackJobs) {
    const candidate = candidates.find((item) => item.id === job.snackCandidateId);
    const row = document.createElement("div"); row.dataset.assetJob = job.id;
    const identity = document.createElement("div");
    const name = document.createElement("strong"); name.textContent = candidate?.revision?.publicTitle || "Approved Snack";
    const detail = document.createElement("span");
    const topic = [...Object.values(THEME_CATALOG), ...(preparation.themes || [])].find((item) => item.colour.toLowerCase() === job.topicColour?.toLowerCase());
    detail.textContent = topic ? topic.name : topicsRunning ? "Classifying theme" : job.topicColour ? 'Theme assigned' : "Theme classification pending";
    if (topic) { const swatch = document.createElement('i'); swatch.className = 'topicSwatch'; swatch.style.backgroundColor = topic.colour; detail.prepend(swatch); }
    identity.append(name, detail);
    const actionable = job.topicColour && resolved.length && !portraitsNeeded.length && ['draft','failed','in-review','approved'].includes(job.status);
    const status = document.createElement(actionable ? 'button' : 'span');
    if (status instanceof HTMLButtonElement) {
      status.type = 'button'; status.className = 'btn btnSecondary'; status.textContent = job.status === 'failed' ? 'Retry thumbnail' : ['in-review','approved'].includes(job.status) ? 'Review thumbnail' : 'Generate thumbnail';
      status.disabled = !state.me?.access?.edit;
      status.addEventListener('click', () => ['in-review','approved'].includes(job.status) ? openThumbnailReview(job.id, name.textContent, status) : generateSnackThumbnail(job.id, '', status));
    } else {
      status.className = `statusPill ${job.status === 'in-review' || job.status === 'approved' ? 'statusSuccess' : 'statusWarning'}`;
      status.textContent = job.status === 'in-review' ? 'Ready to review' : job.status === 'approved' ? 'Approved' : ['extracting','grounding','generating'].includes(job.status) ? 'Generating…' : unresolved.length ? 'Waiting for contributor' : portraitsNeeded.length ? 'Waiting for portrait' : !job.topicColour && topicsRunning ? 'Resolving theme' : !job.topicColour ? 'Theme needed' : 'Ready';
    }
    row.append(identity, status); queue.appendChild(row);
    if (['extracting','grounding','generating'].includes(job.status)) startThumbnailStatusPolling(job.id);
  }
  section.appendChild(queue);
  const requestedAsset = new URLSearchParams(window.location.search).get('asset');
  if (requestedAsset) queueMicrotask(() => {
    const targetJob = [...snackJobs, ...(episodeJob ? [episodeJob] : [])].find((job) => job.id === requestedAsset);
    const target = section.querySelector(`[data-asset-job="${CSS.escape(requestedAsset)}"]`); target?.classList.add('assetRowFocused'); target?.scrollIntoView({ block:'center' });
    if (targetJob && ['in-review','approved'].includes(targetJob.status) && !document.querySelector('.thumbnailReviewDialog')) {
      const candidate = candidates.find((item) => item.id === targetJob.snackCandidateId);
      void openThumbnailReview(targetJob.id, targetJob.assetKind === 'episode' ? episode.publicTitle || episode.workingTitle : candidate?.revision?.publicTitle || 'Approved Snack', null, targetJob.assetKind === 'episode');
    }
  });
  const requestedContributor = new URLSearchParams(window.location.search).get('contributor');
  if (requestedContributor) queueMicrotask(() => {
    const target = section.querySelector(`[data-contributor-id="${CSS.escape(requestedContributor)}"]`);
    target?.classList.add('assetRowFocused'); target?.scrollIntoView({ block: 'center' });
  });
  return section;
}

function portraitsNeededCount(preparation) { return preparation.contributorsNeedingPortraits?.length || 0; }

function renderPublicationPackageManifest(packageValue) {
  const panel = document.createElement('section');
  panel.className = 'publicationPackageManifest';
  const validationCurrent = state.websiteValidation?.packageFingerprint === packageValue.fingerprint && state.websiteValidation?.status === 'passed';
  const publicationCurrent = validationCurrent && state.gitPublication?.validationAttemptId === state.websiteValidation.id && state.gitPublication?.status === 'published' && state.gitPublication?.mainPushed;
  const deploymentCurrent = publicationCurrent && state.gitDeployment?.publicationAttemptId === state.gitPublication.id && state.gitDeployment?.status === 'deployed' && state.gitDeployment?.deployedPushed;
  const header = document.createElement('header');
  const copy = document.createElement('div');
  const eyebrow = document.createElement('p'); eyebrow.className = 'eyebrow'; eyebrow.textContent = 'Release';
  const title = document.createElement('h3'); title.textContent = deploymentCurrent ? 'Episode deployed' : publicationCurrent ? 'Ready to deploy' : validationCurrent ? 'Ready to publish' : packageValue.ready ? 'Ready to validate' : 'Package needs attention';
  const detail = document.createElement('p'); detail.textContent = `${packageValue.snacks?.length || 0} Snacks and ${packageValue.people?.length || 0} contributors will be published to Intelligence Snacks.`;
  copy.append(eyebrow, title, detail);
  const meta = document.createElement('div'); meta.className = 'publicationPackageMeta';
  const stage = document.createElement('button'); stage.type = 'button'; stage.className = 'btn btnPrimary'; stage.textContent = 'Validate publication'; stage.disabled = !packageValue.ready || !state.me?.access?.edit;
  stage.addEventListener('click', async () => { const clear = setButtonBusy(stage, 'Validating website…'); setStudioStatus('Staging website package and running the production build…'); try { state.websiteValidation = (await api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/website-validation`, { method:'POST', body:'{}' })).validation; renderEpisodeWorkspace(state.activeEpisode, state.activeTranscript, state.transcriptRevisions, state.episodeAuditEvents, state.candidates); setStudioStatus(state.websiteValidation.status === 'passed' ? 'Website package validated' : 'Website validation failed'); } catch (error) { setStudioStatus(error.message); } finally { clear(); } });
  if (!validationCurrent) meta.appendChild(stage);
  header.append(copy, meta); panel.appendChild(header);
  const progress = document.createElement('ol'); progress.className = 'publicationReleaseProgress';
  for (const [label, complete, active] of [['Validate', validationCurrent, !validationCurrent], ['Publish', publicationCurrent, validationCurrent && !publicationCurrent], ['Deploy', deploymentCurrent, publicationCurrent && !deploymentCurrent]]) {
    const item = document.createElement('li'); if (complete) item.className = 'isComplete'; else if (active) item.className = 'isActive';
    const marker = document.createElement('span'); marker.textContent = complete ? '✓' : String(progress.children.length + 1); const text = document.createElement('strong'); text.textContent = label; item.append(marker, text); progress.appendChild(item);
  }
  panel.appendChild(progress);
  const blockers = packageValue.blockers || [];
  if (blockers.length) {
    const list = document.createElement('ul'); list.className = 'publicationPackageBlockers';
    const snackThemes = blockers.filter((item) => /needs one theme from the episode/i.test(item.message)).length;
    const snackThumbnails = blockers.filter((item) => /needs an approved finished thumbnail/i.test(item.message) && !/^The episode/i.test(item.message)).length;
    const grouped = blockers.filter((item) => !/needs one theme from the episode/i.test(item.message) && !(/needs an approved finished thumbnail/i.test(item.message) && !/^The episode/i.test(item.message)));
    if (snackThemes) grouped.push({ code: 'snack-themes-group', message: `Automatic theme assignment is pending for ${snackThemes} Snacks.` });
    if (snackThumbnails) grouped.push({ code: 'snack-thumbnails-group', message: `${snackThumbnails} Snack thumbnails need generation or approval.` });
    for (const blocker of grouped) {
      const item = document.createElement('li'); const message = document.createElement('span'); message.textContent = blocker.message; item.appendChild(message);
      const destination = publicationBlockerDestination(blocker);
      if (destination) { const action = document.createElement('button'); action.type = 'button'; action.className = 'btn btnSecondary'; action.textContent = destination.label; action.addEventListener('click', () => navigate(destination.path)); item.appendChild(action); }
      list.appendChild(item);
    }
    panel.appendChild(list);
  }
  const paths = document.createElement('details'); paths.className = 'publicationTechnicalDetails';
  const summary = document.createElement('summary'); summary.textContent = 'Technical details';
  const fingerprint = document.createElement('p'); fingerprint.className = 'metadata'; fingerprint.textContent = `Package ${packageValue.fingerprint?.slice(0, 12) || 'not resolved'} · ${packageValue.files?.length || 0} destination files`;
  const fileList = document.createElement('ul'); fileList.className = 'publicationPackageFiles';
  for (const file of packageValue.files || []) { const item = document.createElement('li'); const kind = document.createElement('span'); kind.textContent = file.kind; const path = document.createElement('code'); path.textContent = file.destination; item.append(kind, path); fileList.appendChild(item); }
  paths.append(summary, fingerprint, fileList); panel.appendChild(paths);
  if (state.websiteValidation) panel.appendChild(renderWebsiteValidation(state.websiteValidation, packageValue, state.gitPublication, state.gitDeployment));
  return panel;
}

function publicationBlockerDestination(blocker) {
  const episodeId = state.activeEpisode?.id; if (!episodeId) return null;
  const base = `/episodes/${encodeURIComponent(episodeId)}`;
  if (['episode-not-approved'].includes(blocker.code) || blocker.code?.startsWith('approved-')) return { label: 'Open Snacks', path: `${base}/snacks` };
  if (blocker.code === 'public-transcript-missing') return { label: 'Review transcript', path: `${base}/publication?gate=transcript` };
  if (blocker.code === 'newsletter-selection-incomplete') return { label: 'Choose Snacks', path: `${base}/publication?gate=newsletter` };
  if (blocker.code === 'portrait-missing' && blocker.sourceId) return { label: 'Open contributor', path: `${base}/assets?contributor=${encodeURIComponent(blocker.sourceId)}` };
  if (blocker.code === 'snack-thumbnail-missing' && blocker.sourceId) {
    const job = state.publicationPreparation?.jobs?.find((item) => item.assetKind === 'snack' && item.snackCandidateId === blocker.sourceId);
    return { label: 'Open thumbnail', path: `${base}/assets${job ? `?asset=${encodeURIComponent(job.id)}` : ''}` };
  }
  if (blocker.code === 'episode-thumbnail-missing') {
    const job = state.publicationPreparation?.jobs?.find((item) => item.assetKind === 'episode');
    return { label: 'Open thumbnail', path: `${base}/assets${job ? `?asset=${encodeURIComponent(job.id)}` : ''}` };
  }
  if (['participant-unresolved','episode-themes-missing','snack-theme-missing','snack-themes-group','snack-thumbnails-group'].includes(blocker.code)) return { label: 'Open Assets', path: `${base}/assets` };
  if (['episode-number-missing','transcript-missing'].includes(blocker.code)) return { label: 'Open Overview', path: base };
  return null;
}

function renderWebsiteValidation(validation, packageValue, publication, deployment) {
  const result = document.createElement('section'); result.className = 'websiteValidationResult';
  const current = validation.packageFingerprint === packageValue.fingerprint;
  const header = document.createElement('div');
  const title = document.createElement('strong'); title.textContent = validation.status === 'passed' && current ? 'Website build passed' : validation.status === 'failed' ? 'Website build failed' : 'Previous package validation';
  const status = document.createElement('span'); status.className = `statusPill ${validation.status === 'passed' && current ? 'statusSuccess' : 'statusWarning'}`; status.textContent = !current ? 'Package changed' : validation.status;
  header.append(title, status); result.appendChild(header);
  const meta = document.createElement('p'); meta.textContent = `${validation.changedFiles?.length || 0} changed files · base ${validation.baseCommit?.slice(0, 12) || 'not resolved'}`; result.appendChild(meta);
  if (validation.failureSummary) { const failure = document.createElement('pre'); failure.textContent = validation.failureSummary; result.appendChild(failure); }
  if (validation.diffStat) { const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'File change summary'; const pre = document.createElement('pre'); pre.textContent = validation.diffStat; details.append(summary, pre); result.appendChild(details); }
  if (validation.textDiff) { const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Content diff'; const pre = document.createElement('pre'); pre.textContent = validation.textDiff; details.append(summary, pre); result.appendChild(details); }
  const matchingPublication = publication?.validationAttemptId === validation.id && publication.packageFingerprint === packageValue.fingerprint;
  const published = matchingPublication && publication.status === 'published' && publication.mainPushed;
  if (matchingPublication) {
    const publicationResult = document.createElement('div'); publicationResult.className = `gitPublicationResult ${published ? 'isPublished' : publication.status === 'failed' ? 'isFailed' : ''}`;
    const copy = document.createElement('div');
    const heading = document.createElement('strong'); heading.textContent = published ? 'Published to website main' : publication.status === 'failed' ? 'Publication failed' : 'Publication in progress';
    const detail = document.createElement('p'); detail.textContent = published ? `Commit ${publication.commitSha?.slice(0, 12) || ''} is on main. The deployed branch has not been changed.` : publication.failureSummary || publication.status;
    copy.append(heading, detail); publicationResult.appendChild(copy); result.appendChild(publicationResult);
  }
  if (validation.status === 'passed' && current && !published) {
    const actions = document.createElement('div'); actions.className = 'gitPublicationActions';
    const note = document.createElement('p'); note.textContent = 'Creates a commit from this exact validated package, verifies a clean production build, then pushes it to website main. This does not deploy it.';
    const publish = document.createElement('button'); publish.type = 'button'; publish.className = 'btn btnPrimary'; publish.textContent = matchingPublication && publication.status !== 'failed' ? 'Publishing…' : 'Publish website update';
    publish.disabled = !state.me?.access?.edit || (matchingPublication && !['failed'].includes(publication.status));
    publish.addEventListener('click', async () => {
      if (!window.confirm('Publish this validated package to the Intelligence Snacks main branch? This creates and pushes a Git commit, but does not deploy the website.')) return;
      const clear = setButtonBusy(publish, 'Publishing to main…'); setStudioStatus('Building the exact commit and publishing it to website main…');
      try {
        state.gitPublication = (await api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/git-publication`, { method:'POST', body:'{}' })).publication;
        renderEpisodeWorkspace(state.activeEpisode, state.activeTranscript, state.transcriptRevisions, state.episodeAuditEvents, state.candidates);
        setStudioStatus(state.gitPublication.status === 'published' ? 'Published to website main' : state.gitPublication.failureSummary || 'Publication failed');
      } catch (error) { setStudioStatus(error.message); } finally { clear(); }
    });
    actions.append(note, publish); result.appendChild(actions);
  }
  if (published) {
    const matchingDeployment = deployment?.publicationAttemptId === publication.id && deployment.sourceCommit === publication.commitSha;
    const deployed = matchingDeployment && deployment.status === 'deployed' && deployment.deployedPushed;
    if (matchingDeployment) {
      const deploymentResult = document.createElement('div'); deploymentResult.className = `gitPublicationResult ${deployed ? 'isPublished' : deployment.status === 'failed' ? 'isFailed' : ''}`;
      const copy = document.createElement('div'); const heading = document.createElement('strong'); heading.textContent = deployed ? 'Deployment triggered' : deployment.status === 'failed' ? 'Deployment failed' : 'Deployment in progress';
      const detail = document.createElement('p'); detail.textContent = deployed ? `The deployed branch now points to ${deployment.sourceCommit.slice(0, 12)}. Production verification remains external.` : deployment.failureSummary || deployment.status;
      copy.append(heading, detail); deploymentResult.appendChild(copy); result.appendChild(deploymentResult);
    }
    if (!deployed) {
      const actions = document.createElement('div'); actions.className = 'gitPublicationActions';
      const note = document.createElement('p'); note.textContent = 'Fast-forwards the website deployed branch to this exact published commit. Pushing the branch triggers the production deployment.';
      const deploy = document.createElement('button'); deploy.type = 'button'; deploy.className = 'btn btnPrimary'; deploy.textContent = matchingDeployment && deployment.status !== 'failed' ? 'Deploying…' : 'Deploy website';
      deploy.disabled = !state.me?.access?.edit || (matchingDeployment && deployment.status !== 'failed');
      deploy.addEventListener('click', async () => {
        if (!window.confirm(`Deploy website commit ${publication.commitSha.slice(0, 12)}? This fast-forwards and pushes the deployed branch, triggering the live production build.`)) return;
        const clear = setButtonBusy(deploy, 'Deploying website…'); setStudioStatus('Fast-forwarding the website deployed branch…');
        try {
          state.gitDeployment = (await api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/git-deployment`, { method:'POST', body:'{}' })).deployment;
          renderEpisodeWorkspace(state.activeEpisode, state.activeTranscript, state.transcriptRevisions, state.episodeAuditEvents, state.candidates);
          setStudioStatus(state.gitDeployment.status === 'deployed' ? 'Website deployment triggered' : state.gitDeployment.failureSummary || 'Deployment failed');
        } catch (error) { setStudioStatus(error.message); } finally { clear(); }
      });
      actions.append(note, deploy); result.appendChild(actions);
    }
  }
  return result;
}

function renderEpisodeThumbnailWorkflow(episode, job, resolved, portraitsNeeded) {
  const panel = document.createElement('section'); panel.className = 'episodeThumbnailWorkflow';
  panel.dataset.assetJob = job.id;
  const copy = document.createElement('div');
  const eyebrow = document.createElement('p'); eyebrow.className = 'eyebrow'; eyebrow.textContent = 'Episode thumbnail';
  const title = document.createElement('h3'); title.textContent = episode.publicTitle || episode.workingTitle;
  const detail = document.createElement('p'); detail.textContent = `16:9 · ${resolved.some((item) => !['pete-winn','andy-david'].includes(item.contributorId)) ? 'Guest layout' : 'Host-only layout'} · deterministic title and branding`;
  if (portraitsNeeded.length) detail.textContent += ` · waiting for ${portraitsNeeded.map((item) => item.name).join(', ')} portrait approval`;
  copy.append(eyebrow, title, detail);
  const actions = document.createElement('div'); actions.className = 'episodeThumbnailActions';
  const active = ['extracting','grounding','generating'].includes(job.status);
  const generate = document.createElement('button'); generate.type = 'button'; generate.className = 'btn btnPrimary';
  generate.textContent = active ? 'Generating…' : ['in-review','approved'].includes(job.status) ? 'Review thumbnail' : job.status === 'failed' ? 'Retry generation' : 'Generate thumbnail';
  generate.disabled = active || portraitsNeeded.length > 0 || !state.me?.access?.edit;
  generate.addEventListener('click', () => ['in-review','approved'].includes(job.status) ? openThumbnailReview(job.id, title.textContent, generate, true) : generateSnackThumbnail(job.id, '', generate));
  const uploadInput = document.createElement('input'); uploadInput.type = 'file'; uploadInput.accept = 'image/png,image/jpeg,image/webp'; uploadInput.hidden = true;
  const upload = document.createElement('button'); upload.type = 'button'; upload.className = 'btn btnSecondary'; upload.textContent = 'Upload finished thumbnail'; upload.disabled = active || !state.me?.access?.edit;
  const uploadStatus = document.createElement('span'); uploadStatus.className = 'episodeThumbnailUploadStatus'; uploadStatus.setAttribute('role', 'status');
  upload.addEventListener('click', () => uploadInput.click());
  uploadInput.addEventListener('change', async () => {
    const file = uploadInput.files?.[0]; if (!file) return;
    uploadStatus.textContent = `${file.name} selected`;
    const clear = setButtonBusy(upload, 'Uploading…');
    try {
      const form = new FormData(); form.append('file', file);
      const uploaded = await apiForm(`/api/thumbnail-jobs/${encodeURIComponent(job.id)}/upload`, form);
      if (!uploaded.job?.candidates?.length) throw new Error('The upload completed without a reviewable thumbnail');
      uploadStatus.textContent = `${file.name} uploaded`;
      const [preparationPayload, packagePayload] = await Promise.all([
        api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/publication-preparation`),
        api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/publication-package`).catch(() => ({ package: state.publicationPackage })),
      ]);
      state.publicationPreparation = preparationPayload.preparation;
      state.publicationPackage = packagePayload.package || state.publicationPackage;
      renderEpisodeWorkspace(state.activeEpisode, state.activeTranscript, state.transcriptRevisions, state.episodeAuditEvents, state.candidates);
      setStudioStatus('Episode artwork uploaded and ready to review');
      await openThumbnailReview(job.id, title.textContent, null, true);
    } catch (error) {
      uploadStatus.textContent = `Upload failed: ${error.message}`;
      setStudioStatus(error.message);
    } finally { clear(); uploadInput.value = ''; }
  });
  actions.append(generate, upload, uploadInput, uploadStatus); panel.append(copy, actions);
  if (active) startThumbnailStatusPolling(job.id);
  return panel;
}

function startThumbnailStatusPolling(jobId) {
  if (state.thumbnailPollTimers[jobId]) return;
  const poll = async () => {
    if (!state.activeEpisode || !['assets', 'publication'].includes(state.activeEpisodeTab)) {
      clearInterval(state.thumbnailPollTimers[jobId]);
      delete state.thumbnailPollTimers[jobId];
      return;
    }
    try {
      const payload = await api(`/api/thumbnail-jobs/${encodeURIComponent(jobId)}`);
      if (['extracting','grounding','generating'].includes(payload.job.status)) return;
      clearInterval(state.thumbnailPollTimers[jobId]);
      delete state.thumbnailPollTimers[jobId];
      state.publicationPreparation = (await api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/publication-preparation`)).preparation;
      renderEpisodeWorkspace(state.activeEpisode, state.activeTranscript, state.transcriptRevisions, state.episodeAuditEvents, state.candidates);
      setStudioStatus(payload.job.status === 'failed' ? `Thumbnail failed: ${payload.job.failureSummary || 'Generation did not complete'}` : 'Thumbnail ready to review');
    } catch {
      // A transient request failure should not stop status updates.
    }
  };
  state.thumbnailPollTimers[jobId] = setInterval(poll, 4000);
  void poll();
}

function setButtonBusy(button, label) {
  if (!(button instanceof HTMLButtonElement)) return () => {};
  const original = { disabled: button.disabled, text: button.textContent };
  button.disabled = true; button.classList.add('isBusy'); button.textContent = label;
  button.setAttribute('aria-busy', 'true');
  return () => { button.disabled = original.disabled; button.classList.remove('isBusy'); button.textContent = original.text; button.removeAttribute('aria-busy'); };
}

async function generateSnackThumbnail(jobId, reviewNote = '', triggerButton = null) {
  const clearBusy = setButtonBusy(triggerButton, reviewNote ? 'Regenerating…' : 'Starting…');
  setStudioStatus('Starting thumbnail generation…');
  try {
    const prepared = await api(`/api/thumbnail-jobs/${encodeURIComponent(jobId)}/generate`, { method: 'POST', body: JSON.stringify({ reviewNote }) });
    const authorization = await signNip98Request(prepared.triggerRequest);
    await api(`/api/thumbnail-jobs/${encodeURIComponent(jobId)}/start`, {
      method: 'POST', body: JSON.stringify({ autopilotAuthorization: authorization, triggerRequest: prepared.triggerRequest }),
    });
    state.publicationPreparation = (await api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/publication-preparation`)).preparation;
    renderEpisodeWorkspace(state.activeEpisode, state.activeTranscript, state.transcriptRevisions, state.episodeAuditEvents, state.candidates);
    setStudioStatus('Generating thumbnail…');
  } catch (error) { clearBusy(); setStudioStatus(error.message); }
}

async function openThumbnailReview(jobId, snackTitle, triggerButton = null, isEpisode = false) {
  if (state.activeEpisodeTab === 'assets' && new URLSearchParams(window.location.search).get('asset') !== jobId) pushEpisodeTabHistory({ asset: jobId });
  const clearBusy = setButtonBusy(triggerButton, 'Opening…');
  setStudioStatus('Loading thumbnail review…');
  try {
    const payload = await api(`/api/thumbnail-jobs/${encodeURIComponent(jobId)}`);
    document.querySelector('.thumbnailReviewDialog')?.remove();
    const dialog = document.createElement('dialog'); dialog.className = `thumbnailReviewDialog${isEpisode ? ' episodeThumbnailReviewDialog' : ''}`;
    const shell = document.createElement('div'); shell.className = `thumbnailReviewShell${isEpisode ? ' episodeThumbnailReviewShell' : ''}`;
    const header = document.createElement('header');
    const copy = document.createElement('div');
    const eyebrow = document.createElement('p'); eyebrow.className = 'eyebrow'; eyebrow.textContent = isEpisode ? 'Episode thumbnail review' : 'Thumbnail review';
    const title = document.createElement('h2'); title.textContent = snackTitle;
    copy.append(eyebrow, title);
    const close = document.createElement('button'); close.type = 'button'; close.className = 'btn btnSecondary'; close.textContent = 'Back to assets'; close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { dialog.remove(); if (state.activeEpisodeTab === 'assets' && new URLSearchParams(window.location.search).get('asset') === jobId) replaceEpisodeTabState({ asset: null }); });
    header.append(copy, close); shell.appendChild(header);
    const currentRound = Math.max(0, ...payload.job.candidates.map((item) => item.generationRound));
    const candidates = payload.job.candidates.filter((item) => item.generationRound === currentRound);
    const gallery = document.createElement('div'); gallery.className = `thumbnailReviewGallery${isEpisode ? ' episodeThumbnailReviewGallery' : ''}`;
    for (const candidate of candidates) {
      const card = document.createElement('article');
      const image = document.createElement('img'); image.alt = `Thumbnail candidate ${candidate.candidateNumber}`;
      let sourceBlob = null;
      fetch(candidate.previewUrl, { headers: state.token ? { authorization: `Bearer ${state.token}` } : {} })
        .then((res) => res.ok ? res.blob() : Promise.reject(new Error('Thumbnail image could not be loaded')))
        .then((blob) => { sourceBlob = blob; image.src = URL.createObjectURL(blob); })
        .catch((error) => { card.classList.add('thumbnailLoadFailed'); image.alt = error.message; setStudioStatus(error.message); });
      const action = document.createElement('button'); action.type = 'button'; action.className = candidate.status === 'approved' ? 'btn btnPrimary' : 'btn btnSecondary';
      action.textContent = candidate.status === 'approved' ? 'Approved' : 'Approve this thumbnail'; action.disabled = candidate.status === 'approved' || !state.me?.access?.edit;
      action.addEventListener('click', () => approveSnackThumbnail(candidate.id, dialog, action));
      if (isEpisode) {
        const stage = document.createElement('div'); stage.className = 'episodeThumbnailCanvasStage'; stage.appendChild(image);
        const previews = document.createElement('div'); previews.className = 'episodeThumbnailPreviews';
        for (const [label, className] of [['Homepage', 'episodePreviewHomepage'], ['Mobile', 'episodePreviewMobile'], ['Social', 'episodePreviewSocial']]) {
          const preview = document.createElement('figure'); preview.className = className;
          const previewImage = document.createElement('img'); previewImage.alt = `${label} preview`; previewImage.src = image.src;
          image.addEventListener('load', () => { previewImage.src = image.src; }, { once: true });
          const caption = document.createElement('figcaption'); caption.textContent = label;
          preview.append(previewImage, caption); previews.appendChild(preview);
        }
        const actions = document.createElement('div'); actions.className = 'thumbnailReviewActions';
        const download = document.createElement('button'); download.type = 'button'; download.className = 'btn btnSecondary'; download.textContent = 'Download high-resolution';
        download.addEventListener('click', () => {
          if (!sourceBlob) return setStudioStatus('The high-resolution image is still loading…');
          const url = URL.createObjectURL(sourceBlob); const anchor = document.createElement('a');
          anchor.href = url; anchor.download = `episode-${state.activeEpisode?.episodeNumber || 'thumbnail'}-thumbnail.${sourceBlob.type.includes('png') ? 'png' : 'webp'}`;
          anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        });
        actions.append(action, download); card.append(stage, previews, actions);
      } else card.append(image, action);
      gallery.appendChild(card);
    }
    shell.appendChild(gallery);
    const evidence = document.createElement('section'); evidence.className = 'thumbnailEvidence';
    const evidenceTitle = document.createElement('h3'); evidenceTitle.textContent = 'Transcript-grounded objects'; evidence.appendChild(evidenceTitle);
    if (!payload.job.evidence.length) { const empty = document.createElement('p'); empty.textContent = 'No literal object passed grounding. This set uses a contributor-only composition.'; evidence.appendChild(empty); }
    for (const item of payload.job.evidence) { const row = document.createElement('article'); const strong = document.createElement('strong'); strong.textContent = item.object_name; const quote = document.createElement('p'); quote.textContent = `${item.timestamp_label || ''} ${item.transcript_excerpt}`.trim(); const reason = document.createElement('small'); reason.textContent = item.grounding_rationale; row.append(strong, quote, reason); evidence.appendChild(row); }
    if (!isEpisode) shell.appendChild(evidence);
    const regenerate = document.createElement('form'); regenerate.className = 'thumbnailRegenerate';
    const note = document.createElement('textarea'); note.rows = 2; note.maxLength = 600; note.placeholder = isEpisode ? 'Optional direction for another artwork pass.' : 'Optional direction, for example: make the hand plane larger and improve the contributors’ eye lines.';
    const button = document.createElement('button'); button.type = 'submit'; button.className = 'btn btnSecondary'; button.textContent = 'Generate alternative';
    regenerate.append(note, button); regenerate.addEventListener('submit', async (event) => { event.preventDefault(); const clear = setButtonBusy(button, 'Regenerating…'); dialog.close(); try { await generateSnackThumbnail(jobId, note.value.trim()); } finally { clear(); } });
    shell.appendChild(regenerate); dialog.appendChild(shell); document.body.appendChild(dialog); dialog.showModal(); setStudioStatus('Ready');
  } catch (error) { setStudioStatus(error.message); }
  finally { clearBusy(); }
}

async function approveSnackThumbnail(candidateId, dialog, triggerButton = null) {
  const clearBusy = setButtonBusy(triggerButton, 'Approving…');
  setStudioStatus('Finishing approved thumbnail…');
  try { await api(`/api/thumbnail-candidates/${encodeURIComponent(candidateId)}/approve`, { method: 'POST', body: '{}' }); dialog.close(); state.publicationPreparation = (await api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/publication-preparation`)).preparation; renderEpisodeWorkspace(state.activeEpisode, state.activeTranscript, state.transcriptRevisions, state.episodeAuditEvents, state.candidates); setStudioStatus('Thumbnail approved'); }
  catch (error) { clearBusy(); setStudioStatus(error.message); }
}

function renderContributorPortraitWorkflow(item) {
  const panel = document.createElement('section');
  panel.className = 'contributorPortraitWorkflow';
  panel.dataset.contributorId = item.contributorId;
  const heading = document.createElement('div');
  const copy = document.createElement('div');
  const eyebrow = document.createElement('p'); eyebrow.className = 'eyebrow'; eyebrow.textContent = 'Contributor portrait';
  const title = document.createElement('h3'); title.textContent = item.name;
  const detail = document.createElement('p'); detail.textContent = 'Real photo for identity · Pete and Andy jointly define the coarse voxel style.';
  copy.append(eyebrow, title, detail);
  const generate = document.createElement('button');
  generate.type = 'button'; generate.className = 'btn btnPrimary';
  generate.textContent = ['generating', 'in-review'].includes(item.portraitStatus) ? 'Generate another' : 'Generate portrait';
  generate.disabled = !state.me?.access?.edit || item.portraitStatus === 'generating';
  generate.addEventListener('click', () => generateContributorPortraits(item.contributorId, generate));
  const actions = document.createElement('div'); actions.className = 'contributorPortraitActions';
  const profile = document.createElement('button'); profile.type = 'button'; profile.className = 'btn btnSecondary'; profile.textContent = 'Open profile'; profile.addEventListener('click', () => navigate(`/contributors/${encodeURIComponent(item.contributorId)}?returnTo=${encodeURIComponent(`/episodes/${state.activeEpisode.id}/assets`)}`));
  actions.append(profile, generate); heading.append(copy, actions); panel.appendChild(heading);
  const gallery = document.createElement('div'); gallery.className = 'contributorPortraitGallery';
  panel.appendChild(gallery);
  queueMicrotask(() => loadContributorPortraitJobs(item.contributorId, gallery, item.portraitStatus));
  return panel;
}

async function loadContributorPortraitJobs(contributorId, gallery, portraitStatus = '') {
  try {
    if (portraitStatus === 'ready-to-generate') { gallery.textContent = 'The previous approved portrait is no longer active. Generate a new coarse-voxel reconstruction from the retained identity photo.'; return; }
    const payload = await api(`/api/contributors/${encodeURIComponent(contributorId)}/portrait-jobs`);
    state.contributorPortraitJobs[contributorId] = payload.jobs || [];
    const job = payload.jobs?.[0];
    gallery.replaceChildren();
    if (!job) { gallery.textContent = 'No portrait candidates generated yet.'; return; }
    if (job.status === 'failed') { gallery.textContent = job.failureSummary || 'Portrait generation failed.'; return; }
    if (!job.candidates?.length) { gallery.textContent = job.status === 'running' ? 'Generating portrait candidates…' : 'Portrait generation is prepared…'; return; }
    for (const candidate of job.candidates) {
      const card = document.createElement('article');
      const image = document.createElement('img'); image.alt = `${contributorId} portrait candidate ${candidate.candidateNumber}`;
      fetch(candidate.previewUrl, { headers: state.token ? { authorization: `Bearer ${state.token}` } : {} })
        .then((response) => response.ok ? response.blob() : Promise.reject(new Error('Image unavailable')))
        .then((blob) => { image.src = URL.createObjectURL(blob); });
      const approve = document.createElement('button'); approve.type = 'button'; approve.className = 'btn btnSecondary';
      approve.textContent = candidate.status === 'approved' ? 'Approved' : 'Use this portrait';
      approve.disabled = candidate.status === 'approved' || !state.me?.access?.edit;
      approve.addEventListener('click', () => approveContributorPortrait(candidate.id, approve));
      card.append(image, approve); gallery.appendChild(card);
    }
  } catch (error) { gallery.textContent = error.message; }
}

async function generateContributorPortraits(contributorId, triggerButton = null) {
  const clearBusy = setButtonBusy(triggerButton, 'Starting…');
  setStudioStatus('Preparing contributor portraits…');
  try {
    const prepared = await api(`/api/contributors/${encodeURIComponent(contributorId)}/portrait-jobs`, { method: 'POST', body: '{}' });
    const authorization = await signNip98Request(prepared.triggerRequest);
    await api(`/api/contributor-portrait-jobs/${encodeURIComponent(prepared.job.id)}/start`, {
      method: 'POST', body: JSON.stringify({ autopilotAuthorization: authorization, triggerRequest: prepared.triggerRequest }),
    });
    if (state.route.startsWith('/contributors/')) await refreshContributorDetail(contributorId);
    else {
      state.publicationPreparation = (await api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/publication-preparation`)).preparation;
      renderEpisodeWorkspace(state.activeEpisode, state.activeTranscript, state.transcriptRevisions, state.episodeAuditEvents, state.candidates);
    }
    setStudioStatus('Generating contributor portraits…');
    pollContributorPortrait(contributorId);
  } catch (error) { clearBusy(); setStudioStatus(error.message); }
}

async function pollContributorPortrait(contributorId) {
  const startedAt = Date.now();
  const check = async () => {
    if ((!state.activeEpisode && !state.activeContributor) || Date.now() - startedAt > 20 * 60 * 1000) return;
    try {
      const payload = await api(`/api/contributors/${encodeURIComponent(contributorId)}/portrait-jobs`);
      const job = payload.jobs?.[0];
      if (job && ['in-review', 'approved', 'failed'].includes(job.status)) {
        if (state.route.startsWith('/contributors/')) await refreshContributorDetail(contributorId);
        else {
          state.publicationPreparation = (await api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/publication-preparation`)).preparation;
          renderEpisodeWorkspace(state.activeEpisode, state.activeTranscript, state.transcriptRevisions, state.episodeAuditEvents, state.candidates);
        }
        setStudioStatus(job.status === 'in-review' ? 'Contributor portraits ready to review' : job.status === 'failed' ? (job.failureSummary || 'Portrait generation failed') : 'Contributor portrait approved');
        return;
      }
    } catch {}
    window.setTimeout(check, 5000);
  };
  window.setTimeout(check, 5000);
}

async function approveContributorPortrait(candidateId, triggerButton = null) {
  const clearBusy = setButtonBusy(triggerButton, 'Approving…');
  setStudioStatus('Approving contributor portrait…');
  try {
    const payload = await api(`/api/contributor-portrait-candidates/${encodeURIComponent(candidateId)}/approve`, { method: 'POST', body: '{}' });
    if (state.route.startsWith('/contributors/')) { state.activeContributor = payload.contributor; renderContributorWorkspace(state.activeContributor); }
    else {
      state.publicationPreparation = (await api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/publication-preparation`)).preparation;
      renderEpisodeWorkspace(state.activeEpisode, state.activeTranscript, state.transcriptRevisions, state.episodeAuditEvents, state.candidates);
    }
    setStudioStatus('Contributor portrait approved');
  } catch (error) { clearBusy(); setStudioStatus(error.message); }
}

function renderContributorForm(speakerLabel) {
  const form = document.createElement("form");
  form.className = "contributorProfileForm";
  const heading = document.createElement("div");
  heading.innerHTML = "<p class=\"eyebrow\">New contributor</p><h3>Profile and portrait source</h3><p>This profile will publish with the episode after its voxel portrait is approved.</p>";
  form.appendChild(heading);
  const fields = [
    ["name", "Name", speakerLabel, true],
    ["role", "Role", state.activeEpisode?.episodeNumber ? `Episode ${state.activeEpisode.episodeNumber} guest` : "Episode guest", true],
    ["shortBio", "Short bio", "", true],
    ["biographyMarkdown", "About", "", true, "textarea"],
    ["aliases", "Transcript aliases", speakerLabel, false],
    ["externalUrl", "Website", "", false],
    ["xUrl", "X profile", "", false],
    ["linkedinUrl", "LinkedIn profile", "", false],
    ["nostrUrl", "Nostr profile", "", false],
  ];
  const grid = document.createElement("div");
  grid.className = "contributorProfileFields";
  for (const [name, labelText, value, required, kind] of fields) {
    const label = document.createElement("label");
    const title = document.createElement("span"); title.textContent = labelText;
    const input = document.createElement(kind === "textarea" ? "textarea" : "input");
    input.name = name; input.value = value; input.required = required;
    if (name.toLowerCase().includes('url')) input.type = 'url';
    if (kind === "textarea") input.rows = 4;
    label.append(title, input); grid.appendChild(label);
  }
  const photo = document.createElement("label");
  photo.className = "contributorPhotoField";
  photo.innerHTML = "<span>Reference photo</span><small>JPEG, PNG or WebP up to 12 MB. This is used for identity only and stays private.</small>";
  const photoInput = document.createElement("input"); photoInput.type = "file"; photoInput.name = "photo"; photoInput.accept = "image/jpeg,image/png,image/webp"; photoInput.required = true;
  photo.appendChild(photoInput); grid.appendChild(photo);
  form.appendChild(grid);
  const actions = document.createElement("div"); actions.className = "contributorProfileActions";
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn btnSecondary"; cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => { state.contributorFormOpen = false; renderEpisodeWorkspace(state.activeEpisode, state.activeTranscript, state.transcriptRevisions, state.episodeAuditEvents, state.candidates); });
  const submit = document.createElement("button"); submit.type = "submit"; submit.className = "btn btnPrimary"; submit.textContent = "Save profile";
  actions.append(cancel, submit); form.appendChild(actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    setStudioStatus("Saving contributor profile…");
    try {
      await apiForm("/api/contributors", new FormData(form));
      state.contributorFormOpen = false;
      const payload = await api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/publication-preparation`);
      state.publicationPreparation = payload.preparation;
      renderEpisodeWorkspace(state.activeEpisode, state.activeTranscript, state.transcriptRevisions, state.episodeAuditEvents, state.candidates);
      setStudioStatus("Contributor saved · portrait generation required");
    } catch (error) {
      submit.disabled = false;
      setStudioStatus(error.message);
    }
  });
  return form;
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
  detail.addEventListener("click", () => navigate(`/diagnostics?episode=${encodeURIComponent(state.activeEpisode.id)}`));
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
      const obsoletePipeline = request.operation === "transcript-to-snacks" && request.pipelineName !== targetPipeline;
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
  if (previousRequest?.operation === "transcript-to-snacks" && previousRequest.promptSuiteVersion !== CURRENT_SNACK_PROMPT_SUITE) {
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
  const publicationMetadata = prepared.pipelineRequest?.operation === "publication-metadata";
  state.pipelineRequests = [prepared.pipelineRequest, ...state.pipelineRequests.filter((request) => request.id !== prepared.pipelineRequest.id)];
  if (!publicationMetadata) {
    state.activeGenerationId = "";
    state.activeCandidateId = "";
  }
  state.episodeStage = publicationMetadata ? "publication" : "processing";
  renderEpisodeWorkspace(state.activeEpisode, state.activeTranscript, state.transcriptRevisions, [], state.candidates);
  if (!prepared.requiresAutopilotAuth || !prepared.triggerRequest) throw new Error("Autopilot trigger was not prepared");
  setStudioStatus(publicationMetadata ? "Authorize topic classification with Nostr…" : "Authorize extraction with Nostr…");
  const triggerRequest = structuredClone(prepared.triggerRequest);
  const references = triggerRequest.body?.input?.localContext?.references || [];
  for (const reference of references) {
    reference.authorization = await signNip98Request({ url: reference.url, method: "GET" });
  }
  const autopilotAuthorization = await signNip98Request(triggerRequest);
  setStudioStatus(publicationMetadata ? "Starting topic classification…" : "Starting Autopilot extraction…");
  await api(`/api/episode-pipeline-runs/${encodeURIComponent(prepared.runId)}/start`, {
    method: "POST",
    body: JSON.stringify({ autopilotAuthorization, triggerRequest }),
  });
  await loadEpisode(state.activeEpisode.id);
  setStudioStatus(publicationMetadata ? "Topic classification started" : "Extraction started");
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
    if (state.activeEpisode?.id !== episodeId || !/^\/(episodes|review|assets|publications)\//.test(window.location.pathname)) return stopPolling();
    try {
      const [pipelinePayload, candidatePayload, curationPayload, publicationPayload, publicTranscriptPayload, packagePayload, workPayload] = await Promise.all([
        api(`/api/episodes/${encodeURIComponent(episodeId)}/pipeline-requests`),
        api(`/api/episodes/${encodeURIComponent(episodeId)}/candidates`),
        api(`/api/episodes/${encodeURIComponent(episodeId)}/curation`),
        api(`/api/episodes/${encodeURIComponent(episodeId)}/publication-preparation`).catch(() => ({ preparation: state.publicationPreparation })),
        api(`/api/episodes/${encodeURIComponent(episodeId)}/public-transcript`).catch(() => ({ publicTranscript: state.publicTranscript })),
        api(`/api/episodes/${encodeURIComponent(episodeId)}/publication-package`).catch(() => ({ package: state.publicationPackage })),
        api(`/api/episodes/${encodeURIComponent(episodeId)}/work`).catch(() => ({ work: state.activeWork })),
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
      state.publicationPreparation = publicationPayload.preparation || state.publicationPreparation;
      state.publicTranscript = publicTranscriptPayload.publicTranscript || state.publicTranscript;
      state.publicationPackage = packagePayload.package || state.publicationPackage;
      state.activeWork = workPayload.work || state.activeWork;
      if (state.candidates.length && state.episodeStage === "processing") state.episodeStage = "output";
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
    replaceEpisodeTabState({ run: state.activeGenerationId, snack: null, mode: null });
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
      prepare.textContent = "Continue to Assets";
      prepare.disabled = !state.me?.access?.edit;
      prepare.addEventListener("click", () => navigate(`/episodes/${encodeURIComponent(episode.id)}/assets`));
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
      replaceEpisodeTabState({ run: activeGenerationId, snack: candidate.id, mode: 'read' });
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
  if (state.activeCandidateId !== active.id) {
    state.activeCandidateId = active.id;
    replaceEpisodeTabState({ run: activeGenerationId, snack: active.id, mode: 'read' });
  }
  layout.appendChild(renderCandidateReader(active));
  section.appendChild(layout);
  if (new URLSearchParams(window.location.search).get('mode') === 'edit') queueMicrotask(() => {
    if (!document.querySelector('.candidateEditorDialog')) openCandidateEditor(active, { preserveUrl: true });
  });
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

function openCandidateEditor(candidate, options = {}) {
  if (!options.preserveUrl) pushEpisodeTabHistory({ run: state.activeGenerationId, snack: candidate.id, mode: 'edit' });
  const dialog = document.createElement("dialog");
  dialog.className = "candidateEditorDialog";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "candidateEditorDialogClose";
  close.setAttribute("aria-label", "Close editor");
  close.textContent = "x";
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { dialog.remove(); if (new URLSearchParams(window.location.search).get('mode') === 'edit') replaceEpisodeTabState({ mode: 'read' }); });
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
    const payload = state.publicationPreparation?.jobs?.length
      ? { preparation: state.publicationPreparation }
      : await api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/publication-preparation`, { method: "POST", body: JSON.stringify({}) });
    state.publicationPreparation = payload.preparation;
    state.episodeStage = "publication";
    renderEpisodeWorkspace(state.activeEpisode, state.activeTranscript, state.transcriptRevisions, state.episodeAuditEvents, state.candidates);
    const metadataActive = state.pipelineRequests.some((request) => request.operation === "publication-metadata" && ["created", "awaiting-authorization", "queued", "running", "applying-result"].includes(request.status));
    const cleanupActive = state.pipelineRequests.some((request) => request.operation === 'transcript-normalization' && ['created','awaiting-authorization','queued','running','applying-result'].includes(request.status));
    if (!state.publicTranscript && !cleanupActive) await startPublicTranscriptCleanup();
    if (state.publicationPreparation.needsTopicClassification?.length && !metadataActive) await startPublicationMetadataClassification();
    const graphRequested = state.pipelineRequests.some((request) => request.pipelineName === 'snack-studio-graph-relationships');
    if (!graphRequested) await startGraphRelationshipSuggestions();
    else setStudioStatus("Ready");
  } catch (error) {
    setStudioStatus(error.message);
  }
}

function renderPublicTranscriptWorkflow() {
  const panel = document.createElement('section'); panel.className = 'publicTranscriptPanel';
  const header = document.createElement('div'); header.className = 'curationPanelHeader';
  const copy = document.createElement('div'); const title = document.createElement('h3'); title.textContent = 'Website transcript';
  const help = document.createElement('p'); help.textContent = 'A cleaned reading copy derived from the immutable source transcript.'; copy.append(title, help); header.appendChild(copy); panel.appendChild(header);
  const running = state.pipelineRequests.find((request) => request.operation === 'transcript-normalization' && ['created','awaiting-authorization','queued','running','applying-result'].includes(request.status));
  if (running) { const status = document.createElement('span'); status.className = 'statusPill statusInfo'; status.textContent = 'Preparing…'; header.appendChild(status); return panel; }
  if (!state.publicTranscript) { const pending = document.createElement('p'); pending.textContent = 'Cleanup will start automatically as the publication is prepared.'; panel.appendChild(pending); return panel; }
  const editor = document.createElement('textarea'); editor.className = 'transcriptEditor'; editor.rows = 14; editor.value = state.publicTranscript.transcriptText; editor.disabled = !state.me?.access?.edit || state.publicTranscript.status === 'approved';
  const summary = document.createElement('p'); summary.className = 'metadata'; summary.textContent = state.publicTranscript.cleanupSummary?.join(' · ') || 'Formatting and verbal debris cleaned without changing meaning.';
  const actions = document.createElement('div'); actions.className = 'candidateReaderDecisions';
  const status = document.createElement('span'); status.className = `statusPill ${state.publicTranscript.status === 'approved' ? 'statusSuccess' : 'statusPending'}`; status.textContent = formatEpisodeStatus(state.publicTranscript.status); actions.appendChild(status);
  if (state.publicTranscript.status === 'proposed') {
    const approve = document.createElement('button'); approve.type = 'button'; approve.className = 'btn btnPrimary'; approve.textContent = 'Approve public transcript'; approve.disabled = !state.me?.access?.edit;
    approve.addEventListener('click', async () => { const clear = setButtonBusy(approve, 'Approving…'); try { state.publicTranscript = (await api(`/api/public-transcripts/${encodeURIComponent(state.publicTranscript.id)}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved', transcriptText: editor.value }) })).publicTranscript; state.publicationPackage = (await api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/publication-package`)).package; renderEpisodeWorkspace(state.activeEpisode, state.activeTranscript, state.transcriptRevisions, state.episodeAuditEvents, state.candidates); } catch (error) { setStudioStatus(error.message); } finally { clear(); } }); actions.appendChild(approve);
  }
  panel.append(summary, editor, actions); return panel;
}

function renderNewsletterWorkflow(candidates) {
  const panel = document.createElement('section'); panel.className = 'curationPanel';
  const title = document.createElement('h3'); title.textContent = 'Newsletter edition';
  const help = document.createElement('p'); help.textContent = 'Choose and order the strongest three or four approved Snacks. This doesn’t affect which Snacks publish on the website.';
  panel.append(title, help);
  const selectedIds = (state.curation.newsletterItems || []).map((item) => item.candidateId);
  const choices = document.createElement('div'); choices.className = 'newsletterChoices';
  for (const candidate of candidates.filter((item) => item.reviewDecision === 'accepted')) {
    const row = document.createElement('label'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selectedIds.includes(candidate.id);
    checkbox.disabled = !state.me?.access?.edit || (!checkbox.checked && selectedIds.length >= 4);
    checkbox.addEventListener('change', () => void saveNewsletterOrder(checkbox.checked ? [...selectedIds, candidate.id] : selectedIds.filter((id) => id !== candidate.id)));
    const label = document.createElement('span'); label.textContent = candidate.revision.publicTitle; row.append(checkbox, label); choices.appendChild(row);
  }
  panel.appendChild(choices);
  if (state.curation.newsletterItems?.length) {
    const order = document.createElement('div'); order.className = 'newsletterOrder';
    for (const item of state.curation.newsletterItems) {
      const row = document.createElement('div'); const label = document.createElement('span'); label.textContent = `${item.position}. ${item.title}`; const actions = document.createElement('div');
      for (const [direction, text] of [[-1, 'Move up'], [1, 'Move down']]) { const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btnTransparent'; button.textContent = text; button.disabled = !state.me?.access?.edit || item.position + direction < 1 || item.position + direction > selectedIds.length; button.addEventListener('click', () => moveNewsletterItem(item.candidateId, direction)); actions.appendChild(button); }
      row.append(label, actions); order.appendChild(row);
    }
    panel.appendChild(order);
  }
  return panel;
}

async function startPublicTranscriptCleanup() {
  setStudioStatus('Preparing website transcript…');
  const prepared = await api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/pipeline-requests`, { method: 'POST', body: JSON.stringify({ operation: 'transcript-normalization', pipelineName: 'snack-studio-transcript-cleanup', pipelineVersion: '1', promptSuiteVersion: 'v1-public-transcript-cleanup', resultSchemaVersion: '1', idempotencyKey: crypto.randomUUID(), autopilotTargetId: state.activeAutopilotTargetId || undefined }) });
  const triggerRequest = structuredClone(prepared.triggerRequest);
  for (const reference of triggerRequest.body?.input?.localContext?.references || []) reference.authorization = await signNip98Request({ url: reference.url, method: 'GET' });
  const autopilotAuthorization = await signNip98Request(triggerRequest);
  await api(`/api/episode-pipeline-runs/${encodeURIComponent(prepared.runId)}/start`, { method: 'POST', body: JSON.stringify({ autopilotAuthorization, triggerRequest }) });
  await loadEpisode(state.activeEpisode.id, { stage: 'publication', origin: '/publications' }); setStudioStatus('Preparing website transcript…');
}

async function startGraphRelationshipSuggestions() {
  setStudioStatus('Preparing graph suggestions…');
  const prepared = await api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/pipeline-requests`, { method: 'POST', body: JSON.stringify({ operation: 'publication-metadata', pipelineName: 'snack-studio-graph-relationships', pipelineVersion: '1', promptSuiteVersion: 'v1-graph-relationships', resultSchemaVersion: '3', idempotencyKey: crypto.randomUUID(), autopilotTargetId: state.activeAutopilotTargetId || undefined }) });
  const triggerRequest = structuredClone(prepared.triggerRequest); for (const reference of triggerRequest.body?.input?.localContext?.references || []) reference.authorization = await signNip98Request({ url: reference.url, method: 'GET' });
  const autopilotAuthorization = await signNip98Request(triggerRequest); await api(`/api/episode-pipeline-runs/${encodeURIComponent(prepared.runId)}/start`, { method: 'POST', body: JSON.stringify({ autopilotAuthorization, triggerRequest }) });
  await loadEpisode(state.activeEpisode.id, { stage: 'publication', origin: '/publications' });
}

async function startPublicationMetadataClassification() {
  setStudioStatus("Preparing transcript theme assessment…");
  const prepared = await api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/pipeline-requests`, {
    method: "POST",
    body: JSON.stringify({
      operation: "publication-metadata",
      pipelineName: "snack-studio-publication-metadata",
      pipelineVersion: "3",
      promptSuiteVersion: "v3-governed-theme-classifier",
      resultSchemaVersion: "2",
      idempotencyKey: crypto.randomUUID(),
      autopilotTargetId: state.activeAutopilotTargetId || undefined,
    }),
  });
  state.pipelineRequests = [prepared.pipelineRequest, ...state.pipelineRequests.filter((request) => request.id !== prepared.pipelineRequest.id)];
  if (!prepared.requiresAutopilotAuth || !prepared.triggerRequest) throw new Error("Theme assessment trigger was not prepared");
  const triggerRequest = structuredClone(prepared.triggerRequest);
  for (const reference of triggerRequest.body?.input?.localContext?.references || []) {
    reference.authorization = await signNip98Request({ url: reference.url, method: "GET" });
  }
  const autopilotAuthorization = await signNip98Request(triggerRequest);
  await api(`/api/episode-pipeline-runs/${encodeURIComponent(prepared.runId)}/start`, {
    method: "POST", body: JSON.stringify({ autopilotAuthorization, triggerRequest }),
  });
  await loadEpisode(state.activeEpisode.id, { stage: 'publication', origin: '/publications' });
  setStudioStatus("Deriving episode themes from the transcript…");
}

async function refreshCuration() {
  const [curation, packagePayload] = await Promise.all([api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/curation`), api(`/api/episodes/${encodeURIComponent(state.activeEpisode.id)}/publication-package`).catch(() => ({ package: state.publicationPackage }))]);
  state.curation = curation; state.publicationPackage = packagePayload.package || state.publicationPackage;
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
        publicTitle: null,
        publicSummary: state.activeEpisode.publicSummary,
        primaryTopic: null,
        recordedOn: $("workspaceRecordedOn").value,
        audioUrl: $("workspaceAudioUrl").value,
        videoUrl: $("workspaceVideoUrl").value,
        editorialNotes: $("workspaceEditorialNotes").value,
      }),
    });
    state.activeEpisode = payload.episode;
    setStudioStatus("Metadata saved");
    await loadEpisode(payload.episode.id, { origin: state.workspaceOrigin, stage: 'details' });
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
  if (!profile) throw new Error("Nostr profile not found");
  const normalized = {
    pubkey: rule.pubkey,
    name: typeof profile?.name === "string" ? profile.name : "",
    displayName: typeof profile?.display_name === "string" ? profile.display_name : typeof profile?.displayName === "string" ? profile.displayName : "",
    firstName: typeof profile?.first_name === "string" ? profile.first_name : typeof profile?.firstName === "string" ? profile.firstName : "",
    lastName: typeof profile?.last_name === "string" ? profile.last_name : typeof profile?.lastName === "string" ? profile.lastName : "",
    picture: typeof profile?.picture === "string" ? profile.picture : "",
    cachedAt: Date.now(),
  };
  if (!profileFullName(normalized) && !normalized.picture) throw new Error("Nostr profile is empty");
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
    }, 5000);

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
    socket.addEventListener("close", () => {
      if (!settled) finish(bestEvent ? parseProfileEvent(bestEvent) : null);
    });
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
$("episodesBackButton").addEventListener("click", () => navigate(state.workspaceOrigin || "/"));
$("contributorsBackButton").addEventListener("click", () => navigate(state.contributorReturnTo || '/contributors'));
for (const button of document.querySelectorAll("[data-studio-route]")) {
  button.addEventListener("click", () => navigate(button.dataset.studioRoute));
}
for (const button of document.querySelectorAll('[data-section-route]')) button.addEventListener('click', () => navigate(button.dataset.sectionRoute));
$('openDiagnosticsButton').addEventListener('click', () => navigate('/diagnostics'));
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
