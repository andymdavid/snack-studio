# Archive graph reconciliation

This adds an evidence-pinned reconciliation layer after episode extraction. It does not replace source observations or infer equivalence from topic labels. Canonical concept assignments and directed reasoning links are separate proposals.

## Delivery and activation status

The schema, store, retrieval baseline, staging/review API, CLI, pilot importer and pipeline definitions are implemented on the feature branch. The v10 parent definition under `pipelines/` is staged source, not the active production definition. The new child can be registered separately for a signed shadow run. The running service has not been restarted, its live database has not been migrated, and archive candidate suggestions have not been accepted in bulk.

The existing extraction callback now queues reconciliation in the same transaction as extraction completion. Queueing does not mean a model run has started or finished. The v10 parent definition runs the new reconciliation child after the episode webhook; its failure policy records archive errors separately. Do not switch the service's current graph contract to v10 until both definitions/functions are registered and the shadow run below passes. Existing concurrent runtime changes use v9 while committed main still specifies v7: reconcile those changes before activating v10, rather than overwriting them.

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

1. Merge/reconcile the Studio feature branch with current runtime development. Preserve unrelated dirty files. Validate the full diff before applying migration 043 to a backed-up live database.
2. Register the two versioned function files and the child pipeline v1 from this repository in the user's current pipeline root. Their absolute imports target `/workspace/code/snack-studio`; configure their databasePath explicitly. They never create a missing database or silently install migrations.
3. Run the child against the shadow database for a complete episode. Verify all source assessments and critic recommendations, including meaningful abstentions. Review staged proposals explicitly; confirm unchanged replay, changed transcript rejection and atomic completion. Source-level tests alone do not prove a live model run.
4. Copy the parent v10 definition as a new version, preserving v9. Once the child is verified, enable `SNACK_STUDIO_ARCHIVE_RECONCILIATION=1`. The backend selects v10, the browser fetches its contract, and the trigger carries the absolute `reconciliationDatabasePath`. The backend change requires managed service restart approval and an HTTP smoke test. No restart is implicit in deployment permission.
5. Backfill the remaining archive in reviewed, resumable batches. Keep pending/blocked/failed episodes in the denominator. Preserve all original observations, even if they cannot yet ground new links.
6. Import the reviewed pilot before public cutover. Export Studio concept and relationship registries together; deploy website registry support before publishing new relationship types. Verify exact source links, full node retention, distinct episode reach and partial coverage labels. Website release remains main → fast-forward deployed → push deployed → live verification.

## Retrieval evaluation

The current retrieval baseline uses normalized word forms, inverse-frequency overlap, title weighting and reviewed concept aliases. It is intentionally bounded and transparent, not embedding-based semantic search. Pure paraphrases may be missed. Add reviewed cases outside the memory/harness pilot and measure candidate recall before deciding whether semantic retrieval is needed. Never tune or claim precision from the same three pilot examples alone. A retrieval candidate is not a false public edge: review exists specifically to reject same-topic/non-equivalent matches.

The first isolated archive run grounded 525 of 526 accepted observations across 21 episodes. Source `009c91fd-67c2-45ba-b001-703fe1d48664` (Provider convenience can become business control) needs an exact evidence-span repair. It remains in the website graph. No repair is inferred automatically.

## Validation

Run `bun run check`, `bun test src/graph-reconciliation.test.ts src/knowledge-identities.test.ts src/pipeline.test.ts src/pipeline-requests.test.ts`, and `bun scripts/verify-archive-reconciliation-http.ts /absolute/path/to/shadow.sqlite`. The HTTP smoke owns and stops only a temporary local child server, signs a temporary test identity, and operates on a disposable database copy. It does not launch a model run. The broader committed-main test suite already has three failing tests (over-500 graph selection and two thumbnail trigger authorization cases); compare against main and report rather than treating them as introduced regressions.

Recovery uses the existing SQLite snapshot mechanism. Additive schema leaves source tables intact; restoring a pre-activation snapshot is the recovery path for a failed live migration. Never delete a live archive or re-extract it merely to reduce fragmentation. Growing hub counts and shrinking components are not quality measures by themselves.
