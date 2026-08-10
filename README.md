# Snack Studio

Snack Studio is the private editorial WApp for Intelligence Snacks. It owns episode preparation, transcript working state, snack review, graph curation, thumbnail review, newsletter selection, and publication intent.

Autopilot owns pipeline execution and controlled publication operations. The Intelligence Snacks website repository owns the canonical public schema and published assets. The public website does not depend on Snack Studio at runtime.

## Current implementation

The first foundation slice provides:

- Nostr login with owner, `read`, and `edit` access;
- a responsive Snack Studio application shell;
- durable SQLite migrations and administration;
- episode workspaces with stable IDs and workflow states;
- episode creation, listing, detail, and audit events;
- configurable Autopilot targets and pipeline discovery;
- a health endpoint at `/api/health`.

Legacy pipeline-chat routes remain temporarily while the episode workflow replaces the starter behavior.

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
