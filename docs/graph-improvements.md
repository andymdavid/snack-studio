# Graph publication and review

Graph acceptance means automated exact-transcript validation unless an explicit review record says otherwise. It does not certify truth or human approval. New Snack relationship suggestions enter the existing draft review queue rather than being auto-approved.

Public exports require accepted knowledge on the active transcript revision, accepted edge/link state, eligible endpoints, and canonical published Snack identity. New Snack markdown carries studioCandidateId and studioRevisionId. Legacy snapshots resolve only exact unique title/editorial title/standfirst matches in their source episode. Unmatched drafts are excluded, never silently redirected to a different published article. Current-episode URLs come from the package being published; the graph is written after content staging.

The new concept-review page is /graph-concepts.html. It uses existing Studio authentication and requires edit access for writes. Concepts have stable IDs, proposed/accepted/rejected states, reviewer, rationale, and optimistic concurrency. Only accepted groups with publishable mentions export. A group means related discussions, not equivalent claims. Semantic contradiction/support still requires its own explanation and evidence. Public confidence scores must not be presented as calibrated probabilities.

Migrations 041 and 042 add concept groups and editorial participant membership. Existing thumbnail selections are copied once as labeled legacy participation. Later thumbnail jobs do not alter this membership. Accepted attributed knowledge can infer participation for episodes without an explicit participant review; explicit editorial sets, including an empty set, take precedence.

The renderer shares a bounded, episode-balanced projection with the website. The full node index remains complete. Explicit focus always wins; a selected neighborhood can be read through the connection list even when it exceeds the visual budget. Rebuild with bun run build:graph and copy the checked-in bundle to the website whenever the shared renderer changes. Both graph-view source files must match.

Validation: bun run check; focused graph tests; full bun test. Two pre-existing thumbnail tests require database jobs and fail against an empty database, including the unchanged source checkout. They are not graph regressions. Do not use production data as a test fixture.

Release Studio and the website together after review. Studio requires normal managed deployment/restart to load API/migration changes; no managed restart was performed during implementation. Verify authentication, read-only write refusal, concept review, publication staging, and participant review against the deployed service. Never interpret a successful source build as a live deployment.
