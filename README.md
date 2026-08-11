# Snack Studio

Snack Studio is the private editorial WApp for Intelligence Snacks. It owns episode preparation, transcript working state, snack review, graph curation, thumbnail review, newsletter selection, and publication intent.

Autopilot owns pipeline execution and controlled publication operations. The Intelligence Snacks website repository owns the canonical public schema and published assets. The public website does not depend on Snack Studio at runtime.

## Current implementation

The editorial production workflow currently provides:

- Nostr login with owner, `read`, and `edit` access;
- durable episode workspaces, transcript revisions, audit history, and episode deletion;
- asynchronous, version-pinned transcript-to-Snacks generation through Autopilot;
- authenticated request context and idempotent, run-scoped pipeline callbacks;
- visible pipeline progress, failure, timeout, retry, and historical-run states;
- multiple full generations within one episode workspace;
- focused Snack reading, editing, rejection, and acceptance across generations;
- assembly and approval of one final Snack set from any successful generation;
- targeted alternative generation with evidence reuse, comparison, adoption, and revision recovery;
- newsletter and relationship curation records for later package assembly;
- configurable Autopilot targets and a health endpoint at `/api/health`.

The accepted production transcript pipeline is pinned to the Episode 64 v3
baseline. Targeted regeneration uses its own v1 definition without changing the
full-run prompt suite.

## Development

Install dependencies and verify the project:

```bash
bun run setup
bun run check
bun test
```

In the Wingman environment, use the managed WApp lifecycle rather than starting a separate localhost process from this repository.

## Environment

See `.env.example`. Important values include:

```text
PORT=3000
WAPP_DB_PATH=/data/app.sqlite
SNACK_STUDIO_PIPELINE_NAME=snack-studio-transcript-to-snacks
SNACK_STUDIO_TRANSCRIPT_UPLOAD_DIR=/data/uploads/transcripts
WINGMAN_URL=http://127.0.0.1:3021
WAPP_OWNER_NPUB=npub1...
WAPP_ALLOWED_NPUBS_JSON=[]
```

Database-path precedence is:

1. `SNACK_STUDIO_DB_PATH`
2. legacy `IS_STUDIO_DB_PATH`
3. legacy `CHAT_WAPP_DB_PATH`
4. `WAPP_DB_PATH`
5. `SQLITE_PATH`
6. `DATABASE_PATH`
7. a `file:` `DATABASE_URL`
8. `data/snack-studio.sqlite`

Mount the database, WAL, SHM, snapshots, imports, and backups on persistent storage in deployed environments. Run one application instance while SQLite remains the operational store.

## Access model

- `read` can sign in and inspect Studio records.
- `edit` can create and change records, manage settings, and trigger allowed operations.
- `WAPP_OWNER_NPUB` always receives read and edit access.

Until access rules are configured, the app retains the starter's bootstrap behavior so the first signed-in editor can configure access.

## Boundaries

- Snack Studio is authoritative for private editorial working records.
- Autopilot reads Studio context through authenticated APIs, never direct database access.
- Long-running work belongs in Autopilot pipelines.
- Saving, editorial approval, Git publication, and production deployment are distinct actions.
- Tower is not an Intelligence Snacks editorial-content store.
