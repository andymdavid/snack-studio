# Archive graph reconciliation

This adds an evidence-pinned reconciliation layer after episode extraction. It does not replace source observations or infer equivalence from topic labels. Canonical concept assignments and directed reasoning links are separate proposals.

## Delivery and activation status

The implementation is on the feature branch. The active candidate is archive pipeline v2, which reads app-owned context over delegated NIP-98 and returns results through the attempt-scoped Studio webhook. The earlier direct-SQL v1 and inline v10 parent draft are retired. Nothing has been activated in the running WApp.

Extraction queues reconciliation in its own transaction. With `SNACK_STUDIO_ARCHIVE_RECONCILIATION=1`, Studio advertises a separate schema-6 archive contract, and its authenticated browser signs a fresh follow-up after extraction. It permits one archive run at a time, preserves unsigned attempts for explicit resume, and stops launching when the operator leaves the graph/episode surface. No persistent headless daemon is installed. Reconciliation does not change the existing extraction contract (runtime development currently uses v9; committed main uses v7). Existing concurrent source work must be preserved during integration.

## Invariants

- Immutable observation versions retain exact evidence, speaker, episode and transcript revision independently of deletable extraction rows.
- Exact unchanged observation content shares a stable identity across re-extraction IDs and revisions. Changed meaning produces a distinct identity; a reviewed redirect may relate identities without deleting history.
- Every reasoning proposal cites evidence at both ends. Every concept assignment cites its source. Relationships are cross-episode; source-local edges remain in the extraction graph.
- Review is attributed and append-only. Critic recommendations are not acceptance decisions. Only accepted proposals from completed batches are exported.
- A changed source revision excludes prior decisions from export. Concurrent context changes block new acceptance. An unrelated later episode does not invalidate existing source-grounded decisions.
- Existing pilot imports have a separate scope and never count as completed archive-wide episode analysis.
- Empty proposal lists are legitimate. An explicit reviewer can complete a no-links batch; the automated staging path additionally requires an assessment for every source.
- `graph_reconciliation_jobs` is a durable queue. No polling daemon or scheduler is installed by this PR.

## API

`/api/graph/reconciliation` uses the existing Studio session and read/edit access checks.

- GET: episode reconciliation coverage.
- POST `{action:"queue-archive"}`: enqueue grounded archive episodes once using the same incremental queue. Requires the opt-in flag and editor access.
- POST `{action:"prepare",episodeId,revisionId}`: grounded observations and bounded archive candidates, pinned batch/snapshot.
- POST `{action:"submit",batchId,snapshot,proposals}`: validate and stage proposals against the current snapshot.
- POST `{action:"review",proposalId,decision:"accepted"|"rejected",rationale}`: explicit decision attributed to the authenticated editor.
- POST `{action:"finish",batchId,rationale}`: atomically apply accepted concept mentions and complete the batch. Outstanding proposals block completion.

Existing graph/website styling is reused. No new bespoke page or visual controls are introduced.

## CLI and backfill

Use an isolated SQLite backup first. Every CLI operation requires an explicit `--db` path; there is no production default. `install` adds only the reconciliation schema. The normal application migration is `043_archive_graph_reconciliation` and uses the existing pre-migration backup/transaction mechanism.

```sh
bun scripts/graph-reconciliation.ts install --db /absolute/path/to/shadow.sqlite
bun scripts/graph-reconciliation.ts import-pilot --db /absolute/path/to/shadow.sqlite --concepts /path/to/website/src/data/graph-concepts.json --relationships /path/to/website/src/data/graph-relationships.json
bun scripts/graph-reconciliation.ts backfill --db /absolute/path/to/shadow.sqlite --out /tmp/archive-backfill.json
bun scripts/graph-reconciliation.ts prepare --db /absolute/path/to/shadow.sqlite --episode EPISODE_ID --revision REVISION_ID
bun scripts/graph-reconciliation.ts evaluate --db /absolute/path/to/shadow.sqlite --input /path/to/reviewed-cases.json
```

`backfill` prepares batches and reports candidate counts; it does not generate semantic decisions or accept suggestions. Continue with the staged child pipeline for each explicit episode/revision. `submit`, `review`, `finish` and `export` provide the same primitives for controlled recovery. The CLI export is an editorial registry export, not a public eligibility filter; normal public export uses `buildPublicGraphDataset` to enforce published episode/current accepted node eligibility.

## Pipeline installation and shadow verification

1. Reconcile the feature code with the runtime checkout's existing uncommitted work. Preserve extraction-version changes and unrelated editorial work. Back up the app database and use migration 043 before enabling new routes.
2. Register `snack-studio-archive-reconciliation.v2.json` and its two v2 code functions. No pipeline function may open the Studio database or import its server modules. Studio retains database ownership.
3. Start the archive request through Studio's normal `/api/episodes/:id/pipeline-requests` flow with operation `publication-metadata`, pipeline `snack-studio-archive-reconciliation`, version `2`, prompt suite `v2-api-archive-reconciliation`, schema `6`. Studio prepares a context URL bound to both request and attempt. Its authenticated browser signs that exact GET plus the pipeline trigger. Fetching the context happens immediately at archive launch, not before the preceding extraction run, avoiding expired signatures.
4. The app prepares and records the batch/snapshot for that attempt. The pipeline returns only analysis and critic recommendations through its existing scoped webhook. Studio verifies callback credential, request/attempt identity, current source revision and exact prepared context before staging proposals. An expired signature, old attempt, wrong actor or changed source cannot authorize writes. Duplicate launches do not supersede an unsigned or active attempt.
5. Run a complete model-driven shadow analysis before accepting new archive decisions. Contract tests use a disposable database and actual signed HTTP requests but are not model validation. This session currently lacks API access to launch that live test; an authenticated, authorized Studio/Autopilot context is required.
6. Enable the flag only after review and explicit permission to restart the managed Snack Studio WApp. Do not restart Autopilot. Queue the existing archive via the editor API; future extracted episodes enter the same queue automatically. Failed/unsigned work stays visible through job and pipeline status and requires explicit recovery, rather than an unbounded retry loop.
7. Review proposals, finish batches with an attributed rationale, and export accepted registries together. Deploy the compatible website code before new graph data. Release main → fast-forward deployed → push deployed, with live verification. Source-local observations and site styles remain intact.

## Retrieval evaluation

The current retrieval baseline uses normalized word forms, inverse-frequency overlap, title weighting and reviewed concept aliases. It is intentionally bounded and transparent, not embedding-based semantic search. Pure paraphrases may be missed. Add reviewed cases outside the memory/harness pilot and measure candidate recall before deciding whether semantic retrieval is needed. Never tune or claim precision from the same three pilot examples alone. A retrieval candidate is not a false public edge: review exists specifically to reject same-topic/non-equivalent matches.

The first isolated archive run grounded 525 of 526 accepted observations across 21 episodes. Source `009c91fd-67c2-45ba-b001-703fe1d48664` (Provider convenience can become business control) needs an exact evidence-span repair. It remains in the website graph. No repair is inferred automatically.

## Validation

Run `bun run check`, `bun test src/graph-reconciliation.test.ts src/knowledge-identities.test.ts src/pipeline.test.ts src/pipeline-requests.test.ts`, and `bun scripts/verify-archive-reconciliation-http.ts /absolute/path/to/shadow.sqlite`. The HTTP smoke owns and stops only a temporary local child server, signs a temporary test identity, and operates on a disposable database copy. It does not launch a model run. The broader committed-main test suite already has three failing tests (over-500 graph selection and two thumbnail trigger authorization cases); compare against main and report rather than treating them as introduced regressions.

Recovery uses the existing SQLite snapshot mechanism. Additive schema leaves source tables intact; restoring a pre-activation snapshot is the recovery path for a failed live migration. Never delete a live archive or re-extract it merely to reduce fragmentation. Growing hub counts and shrinking components are not quality measures by themselves.
