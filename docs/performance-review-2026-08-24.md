# Snack Studio performance and interaction review

Date: 2026-08-24

## Executive finding

Snack Studio's perceived slowness is primarily architectural and behavioral, not a design-token rendering problem.

Navigation is network-gated, episode routes fan out into as many as 11 API requests, and most destination views are destroyed and rebuilt from scratch. The current UI offers almost no immediate destination, pressed, pending, optimistic, or completion feedback, so every wait feels like an unacknowledged failure. CSS tokens contribute to the flat interaction quality, but the CSS is not the main source of screen-to-screen latency.

The most important change is to make navigation immediate from cached state and revalidate in the background. The most important interaction change is to establish a coherent state language—rest, hover, pressed, focused, selected, pending, success, and error—at the component level rather than relying on the top-right status string.

## Non-negotiable product requirement: live pipeline state

Caching must never turn into stale-screen behavior. A user must not refresh, leave and return, or manually reopen an episode to see a completed draft, generated thumbnail, portrait, publication artifact, failed job, or any other pipeline result.

The required model is:

1. the WApp records a pending local job immediately and renders it in context;
2. Autopilot runs asynchronously;
3. the verified webhook commits the authoritative result to the WApp database;
4. that commit emits a small domain event to every connected browser that can see it;
5. the active browser patches the affected entity or performs a targeted refetch;
6. reconnecting browsers request every change after their last known event cursor;
7. ordinary route revalidation remains a safety net, not the primary completion mechanism.

Examples of domain events include `snack.draft.completed`, `thumbnail.completed`, `portrait.completed`, `pipeline.failed`, and `episode.updated`. Events should identify the affected episode/entity and its new version, not carry secrets or require the browser to interpret raw pipeline output.

The UI cache is a fast materialized view, not a second source of truth. SQLite remains authoritative, the webhook remains the authoritative completion path, and the event channel keeps open screens synchronized with committed state.

### Universal pipeline-progress contract

Every control that starts an Autopilot pipeline must hand off to a persistent progress state located where the result will appear. The amount of information must be proportional to the operation; “universal” means consistent lifecycle behavior, not one large component used everywhere.

Use two presentation tiers:

1. **Immersive progress** for a main-event workflow that occupies the screen, such as transcript-to-Snacks. It may show a label, percentage or stages when useful, elapsed time, recovery actions, and optional run details.
2. **Compact inline progress** for secondary actions such as thumbnail generation, portrait generation, or a single Snack regeneration. The trigger button disappears and a small progress track occupies approximately the same footprint. It has no percentage, phase list, elapsed-time copy, or diagnostic detail.

For compact inline progress:

- render an indeterminate bar when the pipeline does not provide trustworthy progress;
- if trustworthy progress exists, the bar may advance monotonically without displaying a number;
- keep motion visibly alive so a long step does not look frozen, while respecting reduced-motion preferences;
- survive navigation and reload by rehydrating from the durable local job/run record;
- replace the progress track with the appropriate button again after completion, while the generated result appears in its destination;
- replace it with a concise inline failure state and **Try again** action if the run fails or times out;
- do not require a link to pipeline diagnostics for ordinary use.

The existing transcript-to-Snacks screen remains the starting pattern for immersive progress because it already understands `progressPercent` and `progressLabel`. Thumbnail and portrait generation should reuse its durable run-state mechanics, not its presentation density.

Progress must survive navigation and reload. The local job/run record is created before the trigger, keyed to the affected entity, and rehydrated when that entity is rendered. A route-level activity indicator may summarize background runs, but it must not replace the in-context state.

## Scope and confidence

This review covers the browser architecture, route and API flow, server read paths, local SQLite behavior, static asset footprint, CSS interaction states, and primary-source research into Linear's product approach.

It is based on code inspection and local data-path microbenchmarks, not a production browser trace with a signed-in user. The next phase should add browser marks and collect real p50/p95 timings before and after the first architectural changes.

## What is making navigation slow

### P0: every route is network-gated

`navigate()` updates history and immediately calls the asynchronous `renderRoute()`. Each route loader then fetches fresh data before rendering its content. There is no route cache, stale-while-revalidate path, prefetching, destination skeleton, or optimistic reuse of data already in `state`.

Examples:

- Episodes always calls `GET /api/episodes`.
- Review, assets, and publications always call their respective work projection.
- Library, contributors, graph, diagnostics, and settings all refetch on every entry.
- Returning to a screen does not restore a previously rendered view; it recreates it.

The page container changes immediately, but the meaningful destination content does not. The only acknowledgement is a small top-bar string such as “Loading workflow…”.

Impact: high. This explains slow screen-to-screen movement even when the server and database are healthy.

### P0: an episode navigation creates an 11-request fan-out

Opening an episode requests all of the following in one `Promise.all`, regardless of the active tab:

1. episode, transcript revisions, and audit events;
2. candidates and all candidate revisions;
3. curation;
4. pipeline requests;
5. publication preparation;
6. publication package;
7. website validation;
8. Git publication;
9. Git deployment;
10. work projection;
11. public transcript.

The screen waits for the slowest non-caught request. Most of this data is not necessary to render the first frame of Overview or Snacks. Assets and Publication can also call `preparePublication()` after the initial group completes, extending the time until the route reports “Ready”.

Impact: very high. Even when individual requests are quick, connection scheduling, authentication, JSON parsing, duplicated queries, and tail latency compound. The maximum request—not the average—sets navigation completion.

### P0: route responses can race

`navigate()` launches `renderRoute()` without awaiting it and no route generation, abort signal, or response ownership check exists. A user who clicks between screens quickly can have an older request resolve after a newer navigation and mutate global state or render stale content.

Impact: high for both perceived performance and correctness. It makes the app feel hesitant and can produce flashes or the wrong destination state.

### P1: complete subtree replacement amplifies the delay

Major renderers use `innerHTML = ""` and recreate every element and listener. The episode workspace is completely rebuilt during initial load, polling, decisions, filters, and many mutations.

Consequences:

- no DOM continuity or shared-element continuity;
- lost focus and fragile keyboard use;
- lost local scroll/selection unless manually preserved;
- repeated markdown/string processing and listener creation;
- images can be decoded or fetched again;
- every small state change looks like a screen refresh rather than a local change.

At the current dataset size this is unlikely to be the largest CPU bottleneck, but it is a major architectural ceiling and a major source of visual instability.

### P1: polling repeats broad reads and full renders

While a pipeline is active, the app fetches seven resources every four seconds and rebuilds the entire episode workspace. Contributor portrait polling separately runs every five seconds. There is no visibility pause, changed-at/ETag check, delta response, or targeted component update.

Impact: medium now, high as episode history, revisions, and concurrent work grow. It can also interrupt interaction with the workspace while background work is running.

### P1: server endpoints repeat overlapping computation

The client requests curation, candidates, work projection, publication preparation, and publication package separately, while these server-side projections call overlapping helpers. For example, curation validation rereads candidates, newsletter items, and relationships after curation has already read several of them. Candidate loading also performs a revision query per candidate (an N+1 pattern).

The local database is not currently slow, but the API shape guarantees duplicated work and payload growth.

### P2: payloads are broader than the visible tab needs

`listCandidates()` attaches full revision history to each candidate. Episode detail includes transcript-related data and audit history. Those objects are shipped even when the active tab needs only a title, status, and summary.

Recommended split:

- episode shell: identity, status, counts, latest activity;
- overview detail: metadata and transcript summary;
- snacks detail: candidate summaries and selected candidate body;
- candidate history: lazy on editor/history open;
- assets/publication: tab-specific projections only;
- audit/diagnostics: lazy on explicit open.

### P2: initial static delivery is acceptable but unoptimized

The uncompressed browser JavaScript is about 224 KB, CSS about 68 KB, login bundle about 128 KB, fonts about 440 KB, and the full public image tree about 7.3 MB. The main HTML loads Google Fonts from the network despite local fonts being present. Images lack a consistent `loading="lazy"`, dimensions, decoding policy, and responsive-source strategy.

These choices affect cold load and image-heavy screens, but do not explain the consistent warm navigation delay as strongly as the data flow does.

### P3: CSS/design tokens are not the latency source

The stylesheet uses ordinary borders, shadows, and a small number of transforms/animations. It does not show pervasive blur, backdrop filters, large animated filters, or other obvious GPU-heavy patterns. Paint cost should still be verified in DevTools on image grids, but it is not the leading hypothesis.

The token problem is semantic: the system defines surfaces and colors but not a complete interaction vocabulary.

## Local measurement

Dataset: 7 episodes in the current local SQLite database.

Warm direct-function microbenchmarks (1,000 iterations, approximate mean per operation):

| Read | Mean |
|---|---:|
| episode | 0.010 ms |
| active transcript | 0.146 ms |
| transcript revision metadata | 0.084 ms |
| episode audit events | 0.339 ms |
| candidates with revision history | 0.392 ms |
| curation projection | 0.512 ms |
| pipeline requests | 0.151 ms |

Interpretation: SQLite is healthy at current scale. These are not end-to-end request measurements and do not include HTTP, auth, JSON serialization/parsing, browser rendering, image decoding, or publication helpers. They show that “the database is slow” is not a good leading explanation today.

## Why the interface feels flat

### Missing acknowledgement at the point of action

Many clickable components only change border/background on hover. Most have no deliberate `:active` response. Navigation clicks do not immediately mark the selected destination as pending, and row/card clicks do not show that the click was accepted.

A top-right message is spatially disconnected from the control the user acted on. It is useful as global status but insufficient as primary feedback.

### Missing state grammar

The system needs consistent visual definitions for:

- rest;
- hover/affordance;
- pressed/depressed;
- keyboard focus;
- selected/current;
- pending/busy;
- optimistic/saving;
- success/confirmed;
- warning;
- destructive/error;
- disabled and disabled-with-reason.

Today these states are partial and component-specific. `.btn.isBusy` is a useful start, but it is applied mainly to explicit asynchronous buttons rather than navigation and inline state changes.

### Missing continuity

Good motion is not decoration; it explains causality and hierarchy. Snack Studio generally swaps content without showing where it came from or what changed. Appropriate examples include:

- a pressed navigation item immediately becoming selected/pending;
- a destination content region fading/settling in over 120–180 ms without moving the whole shell;
- an accepted Snack moving into its accepted state with a local color/icon transition;
- a saved field briefly confirming beside the field or section;
- a background job reserving its final layout and progressing in place;
- a modal or menu animating from its trigger origin with focus transfer.

Avoid large page slides, long easing, and motion that blocks input. Motion should explain state change and remain interruptible.

### Missing keyboard and direct-manipulation layer

Snack Studio has keyboard activation for some episode rows, but no coherent shortcut, command, contextual action, or selection system. Mouse travel and repeated opening of detail screens make work feel slower even if network timings improve.

## What to learn from Linear

The useful lesson is not to copy Linear's dark palette or animation curves. It is to treat speed as a product capability across architecture, interaction distance, and feedback.

Linear publicly describes speed as a core feature and has made architectural changes when its original scaling trade-offs created slow workspaces. Its current clients support real-time sync and retain failed changes locally for retry. That is the opposite of making every navigation depend on a fresh remote read.

Linear also describes contextual menus as a way to make common actions faster for mouse users, exposes keyboard equivalents inside those menus, and optimizes small cursor-path details because fractions of a second compound across hundreds of daily interactions. Its shortcut help is searchable and designed to help more users adopt faster paths.

Applied to Snack Studio:

- preserve a local materialized view of recent screens;
- navigate first, synchronize second;
- put common editorial actions where the object is, not behind another screen;
- teach shortcuts in menus/tooltips rather than hiding them in documentation;
- optimize repeated workflows, not just isolated page load;
- make background synchronization visible only when it becomes relevant;
- treat every wait over roughly 100 ms as requiring local acknowledgement.

## Recommended target architecture

### 1. Immediate cached navigation

Introduce a route store keyed by route and entity ID with `data`, `updatedAt`, `status`, and `requestId`.

On navigation:

1. synchronously select the destination in the sidebar;
2. show cached destination content immediately when available;
3. otherwise show a layout-stable skeleton in the destination;
4. start a cancellable background revalidation;
5. apply the response only if it still owns the current route;
6. patch changed regions instead of rebuilding the screen.

### 2. Episode bootstrap endpoint plus lazy tab data

Replace the 11-request universal fan-out with a small route-specific contract.

Suggested API:

- `GET /api/episodes/:id/shell` — identity, status, counts, active work summary;
- `GET /api/episodes/:id/overview`;
- `GET /api/episodes/:id/snacks?generation=...`;
- `GET /api/episodes/:id/assets`;
- `GET /api/episodes/:id/publication`;
- lazy candidate history and audit endpoints.

The shell should be fast enough to render the destination immediately. Tab requests can be prefetched on hover/focus or after the shell becomes interactive.

### 3. Mutation model: optimistic local update, durable reconciliation

For reversible editorial mutations:

- update local state immediately;
- show a local pending marker;
- send the mutation;
- replace pending with a brief confirmation;
- rollback locally and keep the control in context on failure.

For destructive or externally consequential operations, acknowledge immediately but retain confirmation and explicit progress.

### 4. Targeted background updates

Add a WApp-owned authenticated SSE endpoint for committed domain events. This does not need to wait for future Autopilot run-event support: the existing webhook already tells the WApp when authoritative results have been stored, so the WApp can publish its own safe invalidation event at that point.

Use Autopilot SSE later for richer in-progress phases such as step start and agent status. Use the WApp event stream for durable business outcomes such as a saved Snack or completed thumbnail. Keep webhook delivery and the WApp database authoritative.

Until the event stream is available, retain focused polling as a compatibility fallback:

- pause when the document is hidden;
- poll only the active resource;
- include `updatedSince`/ETag semantics;
- update the pipeline/progress region only;
- back off when unchanged;
- stop promptly on route change via `AbortController`.

On visibility regain, SSE reconnect, browser wake, or network recovery, always run a cursor-based catch-up before declaring the screen current. If the cursor is no longer available, revalidate the visible route and any locally pending jobs.

### 5. Component-level rendering

The app can remain framework-free, but it needs explicit view boundaries. Each screen should own stable DOM regions with small update functions. Event delegation can replace hundreds of recreated listeners. Preserve focus, scroll, open disclosures, and selected candidate IDs during data refresh.

Adopting a framework is not itself a performance fix. A small router/store/view layer would solve most immediate problems; a framework becomes valuable if the interaction model continues to grow.

## Interaction foundation

Add semantic interaction tokens rather than one-off animation values:

```css
--motion-instant: 80ms;
--motion-fast: 140ms;
--motion-normal: 200ms;
--ease-out: cubic-bezier(.2, .8, .2, 1);
--ease-standard: cubic-bezier(.2, 0, 0, 1);
--control-hover-overlay: color-mix(in srgb, var(--text-primary) 6%, transparent);
--control-pressed-overlay: color-mix(in srgb, var(--text-primary) 11%, transparent);
--control-pressed-scale: .985;
--pending-opacity: .72;
```

Component rules:

- buttons: color/elevation change on hover, 1–2% scale or 1 px translation on press, spinner/progress in place, no label-width jump;
- navigation: selected indicator changes immediately, pending shimmer/progress only if data exceeds 150–200 ms;
- rows/cards: hover affordance, pressed state, keyboard focus, selected state distinct from hover;
- toggles/decisions: optimistic state at the object, with undo where safe;
- forms: dirty/saving/saved/error state beside the field or section;
- menus/dialogs: origin-aware 120–180 ms entrance, faster exit, correct focus return;
- background work: persistent in-context progress with meaningful phase labels;
- pipeline triggers: choose immersive or compact presentation according to the operation's prominence; secondary-action buttons give way to a same-footprint progress track;
- reduced motion: remove spatial motion while preserving color/icon/status acknowledgement.

Do not add literal device haptics as a primary web strategy. Where supported on appropriate mobile surfaces, light haptics can supplement a committed selection or success, but visual and accessible feedback must carry the interaction.

## Performance budgets and instrumentation

Add `performance.mark()` around:

- interaction received;
- URL/state committed;
- destination shell visible;
- cached content visible;
- fresh data received;
- destination complete;
- mutation optimistic commit;
- mutation server acknowledgement.

Record route name, cache hit, request count, response bytes, long tasks, and data age without recording sensitive content.

Initial product budgets:

| Metric | Target |
|---|---:|
| click to visible acknowledgement | < 50 ms p95 |
| click to destination shell | < 100 ms p95 |
| cached route usable | < 150 ms p95 |
| uncached ordinary route usable on local/LAN deployment | < 500 ms p95 |
| episode shell request count | 1 |
| initial tab request count | <= 2 total |
| long tasks during navigation | none > 50 ms |
| layout shift during navigation | effectively zero |
| committed pipeline result visible on an open screen | < 1 s p95 after webhook commit |
| refresh/re-navigation required to observe completion | never |
| reconnect recovery | automatic, cursor-based, no lost completion |
| accepted pipeline run with only a busy button | never |
| pipeline phase update visible in its progress surface | < 1 s p95 |

Use browser Performance traces and a repeatable Playwright navigation script with warm and cold cache profiles. Test an episode with the largest transcript/revision history, not just the median one.

## Delivery sequence

### Phase 1: instrument and remove the worst waits

- Add route IDs, abort stale requests, and collect timings.
- Render cached lists immediately and revalidate in the background.
- Split episode loading by active tab; stop fetching publication/Git data on Overview and Snacks.
- Add layout-stable route skeletons and immediate selected/pending navigation state.
- Add a WApp domain-event stream from committed webhook results, with reconnect cursors.
- Extract the transcript flow's durable run-state mechanics, then add a compact same-footprint progress treatment for thumbnail and portrait generation without importing the transcript screen's detail level.
- Retain focused polling as fallback, pause it when hidden, and prevent it from rebuilding the full workspace.

Expected outcome: navigation should feel immediate even before server API consolidation.

### Phase 2: consolidate data contracts and rendering

- Add episode shell/tab endpoints.
- Remove duplicated server projection work.
- Replace candidate revision N+1 reads with a joined/batched query and lazy history.
- Introduce stable component regions and targeted patches.
- Add prefetch on hover/focus for high-probability destinations.

Expected outcome: materially lower request count, bytes, tail latency, and interaction disruption.

### Phase 3: interaction quality system

- Add semantic interaction/motion tokens.
- Implement full control-state matrices and local mutation feedback.
- Add contextual menus for high-frequency editorial actions.
- Add a small command palette/shortcut layer and expose shortcuts in menus/tooltips.
- Conduct reduced-motion, keyboard, focus, and screen-reader review.

Expected outcome: the app feels responsive, causal, and crafted rather than merely restyled.

### Phase 4: real-time and scale hardening

- Move active job progress to SSE/deltas.
- Add payload pagination or virtualization where real data volume requires it.
- Add performance regression checks and budgets to CI.
- Re-test on low-power hardware and non-local network conditions.

## Acceptance test for the redesign

A user should be able to click Episodes → Review → a Snack → Assets → Library and always receive a local visual acknowledgement within one frame or two, keep context on Back, and see cached content without waiting for the network. Fresh data should reconcile without replacing the entire screen. If a pipeline completes while any affected screen is open, its committed result must appear automatically without refresh or re-navigation; reconnecting after sleep or network loss must catch up automatically. Every mutation should expose its state at the control or object that initiated it. Global toast/status messages should be secondary confirmation, not the only proof that an interaction occurred.
