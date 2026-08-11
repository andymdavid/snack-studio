import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { DB_BACKUP_DIR, DB_IMPORT_DIR, DB_PATH, PIPELINE_NAME, WINGMAN_URL } from "./config.ts";

type Migration = {
  id: string;
  description: string;
  up: (db: Database) => void;
};

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function backupDatabase(db: Database, reason: string): string | null {
  if (!existsSync(DB_PATH)) return null;
  mkdirSync(DB_BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(DB_BACKUP_DIR, `${stamp}-${reason}.sqlite`);
  db.exec("PRAGMA wal_checkpoint(FULL)");
  db.exec(`VACUUM INTO ${quoteSqlString(backupPath)}`);
  return backupPath;
}

const migrations: Migration[] = [
  {
    id: "001_initial_chat_wapp_schema",
    description: "Initial local chat, auth, access, settings, and pipeline schema",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          pubkey TEXT PRIMARY KEY,
          npub TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS login_challenges (
          pubkey TEXT PRIMARY KEY,
          nonce TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
          token TEXT PRIMARY KEY,
          pubkey TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (pubkey) REFERENCES users(pubkey) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS chats (
          id TEXT PRIMARY KEY,
          pubkey TEXT NOT NULL,
          title TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (pubkey) REFERENCES users(pubkey) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          pubkey TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
          content TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'complete',
          run_id TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS pipeline_runs (
          id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          user_message_id TEXT NOT NULL,
          assistant_message_id TEXT NOT NULL,
          trigger_status TEXT NOT NULL,
          autopilot_run_id TEXT,
          webhook_token TEXT NOT NULL,
          trigger_payload_json TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS access_rules (
          pubkey TEXT NOT NULL,
          npub TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('read', 'edit')),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (pubkey, role)
        );
      `);
    },
  },
  {
    id: "002_compat_existing_demo_databases",
    description: "Bring early demo databases forward without breaking existing local data",
    up(db) {
      if (!hasColumn(db, "pipeline_runs", "trigger_payload_json")) {
        db.exec("ALTER TABLE pipeline_runs ADD COLUMN trigger_payload_json TEXT");
      }
      db.query("DELETE FROM access_rules WHERE role = 'login'").run();
    },
  },
  {
    id: "003_named_autopilot_targets",
    description: "Store named Autopilot targets and remember which target/pipeline served each run",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS autopilot_targets (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          url TEXT NOT NULL,
          default_pipeline TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      if (!hasColumn(db, "pipeline_runs", "autopilot_target_id")) {
        db.exec("ALTER TABLE pipeline_runs ADD COLUMN autopilot_target_id TEXT");
      }
      if (!hasColumn(db, "pipeline_runs", "autopilot_url")) {
        db.exec("ALTER TABLE pipeline_runs ADD COLUMN autopilot_url TEXT");
      }
      if (!hasColumn(db, "pipeline_runs", "pipeline_name")) {
        db.exec("ALTER TABLE pipeline_runs ADD COLUMN pipeline_name TEXT");
      }

      const now = Date.now();
      const existing = db.query("SELECT id FROM autopilot_targets LIMIT 1").get() as { id: string } | null;
      if (!existing) {
        const url = String((db.query("SELECT value FROM app_settings WHERE key = 'autopilotUrl'").get() as { value: string } | null)?.value || WINGMAN_URL).replace(/\/$/, "");
        const pipeline = String((db.query("SELECT value FROM app_settings WHERE key = 'defaultPipeline'").get() as { value: string } | null)?.value || PIPELINE_NAME);
        db.query(`
          INSERT INTO autopilot_targets(id, label, url, default_pipeline, created_at, updated_at)
          VALUES ('default', 'Default Autopilot', ?1, ?2, ?3, ?3)
        `).run(url, pipeline, now);
        db.query(`
          INSERT INTO app_settings(key, value, updated_at)
          VALUES ('currentAutopilotTargetId', 'default', ?1)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(now);
      }
    },
  },
  {
    id: "004_sqlite_snapshot_registry",
    description: "Track exported SQLite snapshots and staged imports",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS db_snapshots (
          id TEXT PRIMARY KEY,
          filename TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL CHECK(kind IN ('manual', 'pre-migration', 'pre-import')),
          size_bytes INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          note TEXT
        );
      `);
    },
  },
  {
    id: "005_is_studio_foundation",
    description: "Add Snack Studio episode workspaces and audit events",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS episodes (
          id TEXT PRIMARY KEY,
          episode_number INTEGER,
          working_title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'transcript-preparation' CHECK(status IN (
            'transcript-preparation',
            'ready-for-extraction',
            'processing',
            'in-review',
            'approved',
            'published',
            'failed'
          )),
          owner_pubkey TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (owner_pubkey) REFERENCES users(pubkey)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS episodes_episode_number_unique
          ON episodes(episode_number)
          WHERE episode_number IS NOT NULL;

        CREATE INDEX IF NOT EXISTS episodes_updated_at_index
          ON episodes(updated_at DESC);

        CREATE TABLE IF NOT EXISTS audit_events (
          id TEXT PRIMARY KEY,
          actor_pubkey TEXT,
          action TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT,
          detail_json TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (actor_pubkey) REFERENCES users(pubkey)
        );

        CREATE INDEX IF NOT EXISTS audit_events_entity_index
          ON audit_events(entity_type, entity_id, created_at DESC);
      `);
    },
  },
  {
    id: "006_episode_metadata_and_transcripts",
    description: "Add episode metadata and immutable transcript sources and revisions",
    up(db) {
      for (const [column, definition] of [
        ["public_title", "TEXT"],
        ["recorded_on", "TEXT"],
        ["audio_url", "TEXT"],
        ["video_url", "TEXT"],
        ["editorial_notes", "TEXT"],
        ["active_transcript_revision_id", "TEXT"],
      ] as const) {
        if (!hasColumn(db, "episodes", column)) db.exec(`ALTER TABLE episodes ADD COLUMN ${column} ${definition}`);
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS transcript_sources (
          id TEXT PRIMARY KEY,
          episode_id TEXT NOT NULL,
          source_kind TEXT NOT NULL CHECK(source_kind IN ('pasted', 'upload')),
          original_filename TEXT,
          media_type TEXT,
          size_bytes INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          source_text TEXT,
          storage_path TEXT,
          created_by_pubkey TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE,
          FOREIGN KEY (created_by_pubkey) REFERENCES users(pubkey)
        );

        CREATE INDEX IF NOT EXISTS transcript_sources_episode_index
          ON transcript_sources(episode_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS transcript_revisions (
          id TEXT PRIMARY KEY,
          episode_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          revision_number INTEGER NOT NULL,
          transcript_text TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          change_note TEXT,
          created_by_pubkey TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE,
          FOREIGN KEY (source_id) REFERENCES transcript_sources(id),
          FOREIGN KEY (created_by_pubkey) REFERENCES users(pubkey),
          UNIQUE (episode_id, revision_number)
        );

        CREATE INDEX IF NOT EXISTS transcript_revisions_episode_index
          ON transcript_revisions(episode_id, revision_number DESC);
      `);
    },
  },
  {
    id: "007_snack_candidate_review",
    description: "Add snack candidates and immutable editorial revisions",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS snack_candidates (
          id TEXT PRIMARY KEY,
          episode_id TEXT NOT NULL,
          review_decision TEXT NOT NULL DEFAULT 'generated' CHECK(review_decision IN (
            'generated', 'in-review', 'accepted', 'rejected', 'regeneration-requested'
          )),
          current_revision_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS snack_candidates_episode_index
          ON snack_candidates(episode_id, created_at ASC);

        CREATE TABLE IF NOT EXISTS snack_revisions (
          id TEXT PRIMARY KEY,
          candidate_id TEXT NOT NULL,
          revision_number INTEGER NOT NULL,
          public_title TEXT NOT NULL,
          editorial_title TEXT,
          standfirst TEXT NOT NULL,
          body_markdown TEXT NOT NULL,
          attribution TEXT,
          primary_topic TEXT,
          related_topics_json TEXT NOT NULL DEFAULT '[]',
          transcript_timestamp TEXT,
          transcript_excerpt TEXT,
          seo_title TEXT,
          seo_description TEXT,
          public_state TEXT NOT NULL DEFAULT 'draft' CHECK(public_state IN ('draft', 'review', 'published')),
          origin TEXT NOT NULL CHECK(origin IN ('fixture', 'pipeline', 'editor')),
          change_note TEXT,
          created_by_pubkey TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (candidate_id) REFERENCES snack_candidates(id) ON DELETE CASCADE,
          FOREIGN KEY (created_by_pubkey) REFERENCES users(pubkey),
          UNIQUE (candidate_id, revision_number)
        );

        CREATE INDEX IF NOT EXISTS snack_revisions_candidate_index
          ON snack_revisions(candidate_id, revision_number DESC);
      `);
    },
  },
  {
    id: "008_newsletter_and_relationship_curation",
    description: "Add newsletter ordering and typed snack relationships",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS newsletter_drafts (
          id TEXT PRIMARY KEY,
          episode_id TEXT NOT NULL UNIQUE,
          working_title TEXT,
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'ready')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS newsletter_items (
          newsletter_id TEXT NOT NULL,
          candidate_id TEXT NOT NULL,
          position INTEGER NOT NULL CHECK(position > 0),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (newsletter_id, candidate_id),
          UNIQUE (newsletter_id, position),
          FOREIGN KEY (newsletter_id) REFERENCES newsletter_drafts(id) ON DELETE CASCADE,
          FOREIGN KEY (candidate_id) REFERENCES snack_candidates(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS relationships (
          id TEXT PRIMARY KEY,
          episode_id TEXT NOT NULL,
          source_candidate_id TEXT NOT NULL,
          target_candidate_id TEXT NOT NULL,
          relationship_type TEXT NOT NULL CHECK(relationship_type IN (
            'overlaps', 'develops', 'contradicts', 'revises', 'exemplifies', 'enables', 'caused-by'
          )),
          explanation TEXT,
          origin TEXT NOT NULL CHECK(origin IN ('manual', 'fixture', 'pipeline')),
          review_state TEXT NOT NULL DEFAULT 'draft' CHECK(review_state IN ('draft', 'approved', 'rejected')),
          created_by_pubkey TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          CHECK(source_candidate_id <> target_candidate_id),
          FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE,
          FOREIGN KEY (source_candidate_id) REFERENCES snack_candidates(id) ON DELETE CASCADE,
          FOREIGN KEY (target_candidate_id) REFERENCES snack_candidates(id) ON DELETE CASCADE,
          FOREIGN KEY (created_by_pubkey) REFERENCES users(pubkey),
          UNIQUE(source_candidate_id, target_candidate_id, relationship_type)
        );

        CREATE INDEX IF NOT EXISTS relationships_episode_index
          ON relationships(episode_id, created_at ASC);
      `);
    },
  },
  {
    id: "009_episode_pipeline_lifecycle",
    description: "Add durable episode pipeline requests, attempts, and versioned artifacts",
    up(db) {
      const legacyPipelineRuns = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pipeline_runs'").get();
      const renamedLegacyRuns = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_pipeline_runs'").get();
      if (legacyPipelineRuns && !renamedLegacyRuns) db.exec("ALTER TABLE pipeline_runs RENAME TO chat_pipeline_runs");

      db.exec(`
        CREATE TABLE IF NOT EXISTS pipeline_requests (
          id TEXT PRIMARY KEY,
          episode_id TEXT NOT NULL,
          operation TEXT NOT NULL CHECK(operation IN ('transcript-to-snacks', 'transcript-normalization')),
          status TEXT NOT NULL DEFAULT 'created' CHECK(status IN (
            'created', 'awaiting-authorization', 'queued', 'running', 'applying-result',
            'completed', 'failed', 'timed-out', 'needs-review', 'cancelled'
          )),
          actor_pubkey TEXT NOT NULL,
          input_transcript_revision_id TEXT NOT NULL,
          input_transcript_sha256 TEXT NOT NULL,
          autopilot_target_id TEXT NOT NULL,
          pipeline_name TEXT NOT NULL,
          pipeline_version TEXT,
          prompt_suite_version TEXT NOT NULL,
          result_schema_version TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          result_applied_at INTEGER,
          failure_summary TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE,
          FOREIGN KEY (actor_pubkey) REFERENCES users(pubkey),
          FOREIGN KEY (input_transcript_revision_id) REFERENCES transcript_revisions(id),
          FOREIGN KEY (autopilot_target_id) REFERENCES autopilot_targets(id)
        );

        CREATE INDEX IF NOT EXISTS pipeline_requests_episode_index
          ON pipeline_requests(episode_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS pipeline_runs (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL,
          attempt_number INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'prepared' CHECK(status IN (
            'prepared', 'awaiting-authorization', 'triggering', 'queued', 'running',
            'complete', 'error', 'timed-out', 'cancelled'
          )),
          autopilot_run_id TEXT,
          callback_token_hash TEXT NOT NULL,
          trigger_payload_json TEXT,
          failure_category TEXT,
          failure_summary TEXT,
          retry_of_run_id TEXT,
          triggered_at INTEGER,
          completed_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (request_id) REFERENCES pipeline_requests(id) ON DELETE CASCADE,
          FOREIGN KEY (retry_of_run_id) REFERENCES pipeline_runs(id),
          UNIQUE(request_id, attempt_number),
          UNIQUE(autopilot_run_id)
        );

        CREATE INDEX IF NOT EXISTS pipeline_runs_request_index
          ON pipeline_runs(request_id, attempt_number DESC);

        CREATE TABLE IF NOT EXISTS pipeline_artifacts (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL,
          run_id TEXT,
          artifact_type TEXT NOT NULL,
          schema_version TEXT NOT NULL,
          content_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (request_id) REFERENCES pipeline_requests(id) ON DELETE CASCADE,
          FOREIGN KEY (run_id) REFERENCES pipeline_runs(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS pipeline_artifacts_request_index
          ON pipeline_artifacts(request_id, artifact_type, created_at ASC);
      `);
    },
  },
  {
    id: "010_pipeline_candidate_provenance",
    description: "Link generated candidates and revisions to validated pipeline provenance",
    up(db) {
      for (const [column, definition] of [
        ["pipeline_request_id", "TEXT"],
        ["selection_id", "TEXT"],
      ] as const) {
        if (!hasColumn(db, "snack_candidates", column)) db.exec(`ALTER TABLE snack_candidates ADD COLUMN ${column} ${definition}`);
      }
      for (const [column, definition] of [
        ["pipeline_request_id", "TEXT"],
        ["pipeline_run_id", "TEXT"],
        ["source_transcript_revision_id", "TEXT"],
        ["prompt_suite_version", "TEXT"],
        ["pipeline_version", "TEXT"],
        ["result_schema_version", "TEXT"],
        ["structure_exception", "TEXT"],
        ["claim_evidence_json", "TEXT NOT NULL DEFAULT '[]'"],
        ["validation_warnings_json", "TEXT NOT NULL DEFAULT '[]'"],
      ] as const) {
        if (!hasColumn(db, "snack_revisions", column)) db.exec(`ALTER TABLE snack_revisions ADD COLUMN ${column} ${definition}`);
      }
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS snack_candidates_pipeline_selection_unique
          ON snack_candidates(pipeline_request_id, selection_id)
          WHERE pipeline_request_id IS NOT NULL AND selection_id IS NOT NULL;
      `);
    },
  },
  {
    id: "011_pipeline_progress",
    description: "Store safe, user-facing progress checkpoints for active pipeline attempts",
    up(db) {
      if (!hasColumn(db, "pipeline_runs", "progress_percent")) db.exec("ALTER TABLE pipeline_runs ADD COLUMN progress_percent INTEGER NOT NULL DEFAULT 0");
      if (!hasColumn(db, "pipeline_runs", "progress_label")) db.exec("ALTER TABLE pipeline_runs ADD COLUMN progress_label TEXT");
    },
  },
  {
    id: "012_approved_snack_order",
    description: "Persist the final order of accepted Snacks across generation runs",
    up(db) {
      if (!hasColumn(db, "snack_candidates", "approved_position")) {
        db.exec("ALTER TABLE snack_candidates ADD COLUMN approved_position INTEGER");
      }
      db.exec(`
        UPDATE snack_candidates AS candidate
        SET approved_position = (
          SELECT COUNT(*)
          FROM snack_candidates AS preceding
          WHERE preceding.episode_id = candidate.episode_id
            AND preceding.review_decision = 'accepted'
            AND (preceding.created_at < candidate.created_at OR (preceding.created_at = candidate.created_at AND preceding.id <= candidate.id))
        )
        WHERE candidate.review_decision = 'accepted' AND candidate.approved_position IS NULL;

        CREATE UNIQUE INDEX IF NOT EXISTS snack_candidates_approved_position_unique
          ON snack_candidates(episode_id, approved_position)
          WHERE approved_position IS NOT NULL;
      `);
    },
  },
  {
    id: "013_snack_regeneration_proposals",
    description: "Store non-destructive proposed revisions from targeted Snack regeneration",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS snack_regeneration_proposals (
          id TEXT PRIMARY KEY,
          candidate_id TEXT NOT NULL,
          base_revision_id TEXT NOT NULL,
          pipeline_request_id TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed', 'adopted', 'discarded')),
          instruction TEXT,
          editorial_title TEXT NOT NULL,
          public_title TEXT NOT NULL,
          standfirst TEXT NOT NULL,
          body_markdown TEXT NOT NULL,
          structure_exception TEXT,
          claim_evidence_json TEXT NOT NULL DEFAULT '[]',
          transcript_excerpt TEXT,
          rationale TEXT,
          validation_warnings_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          resolved_at INTEGER,
          FOREIGN KEY (candidate_id) REFERENCES snack_candidates(id) ON DELETE CASCADE,
          FOREIGN KEY (base_revision_id) REFERENCES snack_revisions(id),
          FOREIGN KEY (pipeline_request_id) REFERENCES pipeline_requests(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS snack_regeneration_proposals_candidate_index
          ON snack_regeneration_proposals(candidate_id, created_at DESC);
      `);
    },
  },
  {
    id: "014_targeted_pipeline_requests",
    description: "Allow pipeline requests to target an immutable Snack revision",
    up(db) {
      db.exec(`
        PRAGMA defer_foreign_keys = ON;
        CREATE TEMP TABLE migration_014_pipeline_runs AS SELECT * FROM pipeline_runs;
        CREATE TEMP TABLE migration_014_pipeline_artifacts AS SELECT * FROM pipeline_artifacts;
        CREATE TEMP TABLE migration_014_regeneration_proposals AS SELECT * FROM snack_regeneration_proposals;
        CREATE TABLE pipeline_requests_new (
          id TEXT PRIMARY KEY,
          episode_id TEXT NOT NULL,
          operation TEXT NOT NULL CHECK(operation IN ('transcript-to-snacks', 'transcript-normalization', 'snack-regeneration')),
          status TEXT NOT NULL DEFAULT 'created' CHECK(status IN (
            'created', 'awaiting-authorization', 'queued', 'running', 'applying-result',
            'completed', 'failed', 'timed-out', 'needs-review', 'cancelled'
          )),
          actor_pubkey TEXT NOT NULL,
          input_transcript_revision_id TEXT NOT NULL,
          input_transcript_sha256 TEXT NOT NULL,
          autopilot_target_id TEXT NOT NULL,
          pipeline_name TEXT NOT NULL,
          pipeline_version TEXT,
          prompt_suite_version TEXT NOT NULL,
          result_schema_version TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          result_applied_at INTEGER,
          failure_summary TEXT,
          target_candidate_id TEXT,
          base_candidate_revision_id TEXT,
          regeneration_instruction TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE,
          FOREIGN KEY (actor_pubkey) REFERENCES users(pubkey),
          FOREIGN KEY (input_transcript_revision_id) REFERENCES transcript_revisions(id),
          FOREIGN KEY (autopilot_target_id) REFERENCES autopilot_targets(id),
          FOREIGN KEY (target_candidate_id) REFERENCES snack_candidates(id) ON DELETE CASCADE,
          FOREIGN KEY (base_candidate_revision_id) REFERENCES snack_revisions(id)
        );
        INSERT INTO pipeline_requests_new(
          id, episode_id, operation, status, actor_pubkey, input_transcript_revision_id,
          input_transcript_sha256, autopilot_target_id, pipeline_name, pipeline_version,
          prompt_suite_version, result_schema_version, idempotency_key, attempt_count,
          result_applied_at, failure_summary, created_at, updated_at
        ) SELECT
          id, episode_id, operation, status, actor_pubkey, input_transcript_revision_id,
          input_transcript_sha256, autopilot_target_id, pipeline_name, pipeline_version,
          prompt_suite_version, result_schema_version, idempotency_key, attempt_count,
          result_applied_at, failure_summary, created_at, updated_at
        FROM pipeline_requests;
        DROP TABLE pipeline_requests;
        ALTER TABLE pipeline_requests_new RENAME TO pipeline_requests;
        CREATE INDEX pipeline_requests_episode_index ON pipeline_requests(episode_id, created_at DESC);
        INSERT INTO pipeline_runs SELECT * FROM migration_014_pipeline_runs;
        INSERT INTO pipeline_artifacts SELECT * FROM migration_014_pipeline_artifacts;
        INSERT INTO snack_regeneration_proposals SELECT * FROM migration_014_regeneration_proposals;
        DROP TABLE migration_014_pipeline_runs;
        DROP TABLE migration_014_pipeline_artifacts;
        DROP TABLE migration_014_regeneration_proposals;
      `);
    },
  },
  {
    id: "015_thumbnail_workflow",
    description: "Add durable thumbnail briefs, grounded objects, candidates, and assets",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS thumbnail_jobs (
          id TEXT PRIMARY KEY,
          episode_id TEXT NOT NULL,
          asset_kind TEXT NOT NULL CHECK(asset_kind IN ('snack', 'episode')),
          snack_candidate_id TEXT,
          snack_revision_id TEXT,
          transcript_revision_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN (
            'draft', 'extracting', 'grounding', 'generating', 'in-review', 'approved', 'failed'
          )),
          topic_colour TEXT,
          contributor_ids_json TEXT NOT NULL DEFAULT '[]',
          selected_candidate_id TEXT,
          review_notes TEXT,
          pipeline_name TEXT,
          pipeline_version TEXT,
          created_by_pubkey TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          CHECK(
            (asset_kind = 'snack' AND snack_candidate_id IS NOT NULL AND snack_revision_id IS NOT NULL)
            OR (asset_kind = 'episode' AND snack_candidate_id IS NULL AND snack_revision_id IS NULL)
          ),
          FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE,
          FOREIGN KEY (snack_candidate_id) REFERENCES snack_candidates(id) ON DELETE CASCADE,
          FOREIGN KEY (snack_revision_id) REFERENCES snack_revisions(id),
          FOREIGN KEY (transcript_revision_id) REFERENCES transcript_revisions(id),
          FOREIGN KEY (created_by_pubkey) REFERENCES users(pubkey)
        );

        CREATE INDEX IF NOT EXISTS thumbnail_jobs_episode_index
          ON thumbnail_jobs(episode_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS thumbnail_jobs_snack_index
          ON thumbnail_jobs(snack_candidate_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS thumbnail_object_evidence (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          object_name TEXT NOT NULL,
          transcript_excerpt TEXT NOT NULL,
          timestamp_label TEXT,
          role_in_snack TEXT NOT NULL,
          grounding_status TEXT NOT NULL DEFAULT 'proposed' CHECK(grounding_status IN ('proposed', 'approved', 'rejected')),
          grounding_rationale TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (job_id) REFERENCES thumbnail_jobs(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS thumbnail_object_evidence_job_index
          ON thumbnail_object_evidence(job_id, created_at ASC);

        CREATE TABLE IF NOT EXISTS thumbnail_candidates (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          generation_round INTEGER NOT NULL CHECK(generation_round > 0),
          candidate_number INTEGER NOT NULL CHECK(candidate_number > 0),
          status TEXT NOT NULL DEFAULT 'generated' CHECK(status IN ('generated', 'approved', 'rejected')),
          source_uri TEXT NOT NULL,
          prompt_text TEXT NOT NULL,
          model_name TEXT,
          width INTEGER,
          height INTEGER,
          mime_type TEXT,
          size_bytes INTEGER,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (job_id) REFERENCES thumbnail_jobs(id) ON DELETE CASCADE,
          UNIQUE(job_id, generation_round, candidate_number)
        );

        CREATE INDEX IF NOT EXISTS thumbnail_candidates_job_index
          ON thumbnail_candidates(job_id, generation_round DESC, candidate_number ASC);

        CREATE TABLE IF NOT EXISTS thumbnail_assets (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          candidate_id TEXT NOT NULL,
          asset_stage TEXT NOT NULL CHECK(asset_stage IN ('source', 'finished')),
          storage_path TEXT NOT NULL,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          mime_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          version_number INTEGER NOT NULL CHECK(version_number > 0),
          created_at INTEGER NOT NULL,
          FOREIGN KEY (job_id) REFERENCES thumbnail_jobs(id) ON DELETE CASCADE,
          FOREIGN KEY (candidate_id) REFERENCES thumbnail_candidates(id) ON DELETE CASCADE,
          UNIQUE(job_id, asset_stage, version_number)
        );

        CREATE INDEX IF NOT EXISTS thumbnail_assets_job_index
          ON thumbnail_assets(job_id, asset_stage, version_number DESC);
      `);
    },
  },
  {
    id: "016_thumbnail_job_identity",
    description: "Keep one publishing thumbnail job per immutable Snack revision",
    up(db) {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS thumbnail_jobs_snack_revision_unique
          ON thumbnail_jobs(snack_revision_id)
          WHERE snack_revision_id IS NOT NULL;
      `);
    },
  },
  {
    id: "017_publication_metadata_pipeline",
    description: "Add publication metadata requests and immutable Snack taxonomy assignments",
    up(db) {
      db.exec(`
        PRAGMA defer_foreign_keys = ON;
        CREATE TEMP TABLE migration_017_pipeline_runs AS SELECT * FROM pipeline_runs;
        CREATE TEMP TABLE migration_017_pipeline_artifacts AS SELECT * FROM pipeline_artifacts;
        CREATE TEMP TABLE migration_017_regeneration_proposals AS SELECT * FROM snack_regeneration_proposals;
        CREATE TABLE pipeline_requests_new (
          id TEXT PRIMARY KEY,
          episode_id TEXT NOT NULL,
          operation TEXT NOT NULL CHECK(operation IN (
            'transcript-to-snacks', 'transcript-normalization', 'snack-regeneration', 'publication-metadata'
          )),
          status TEXT NOT NULL DEFAULT 'created' CHECK(status IN (
            'created', 'awaiting-authorization', 'queued', 'running', 'applying-result',
            'completed', 'failed', 'timed-out', 'needs-review', 'cancelled'
          )),
          actor_pubkey TEXT NOT NULL,
          input_transcript_revision_id TEXT NOT NULL,
          input_transcript_sha256 TEXT NOT NULL,
          autopilot_target_id TEXT NOT NULL,
          pipeline_name TEXT NOT NULL,
          pipeline_version TEXT,
          prompt_suite_version TEXT NOT NULL,
          result_schema_version TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          result_applied_at INTEGER,
          failure_summary TEXT,
          target_candidate_id TEXT,
          base_candidate_revision_id TEXT,
          regeneration_instruction TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE,
          FOREIGN KEY (actor_pubkey) REFERENCES users(pubkey),
          FOREIGN KEY (input_transcript_revision_id) REFERENCES transcript_revisions(id),
          FOREIGN KEY (autopilot_target_id) REFERENCES autopilot_targets(id),
          FOREIGN KEY (target_candidate_id) REFERENCES snack_candidates(id) ON DELETE CASCADE,
          FOREIGN KEY (base_candidate_revision_id) REFERENCES snack_revisions(id)
        );
        INSERT INTO pipeline_requests_new SELECT * FROM pipeline_requests;
        DROP TABLE pipeline_requests;
        ALTER TABLE pipeline_requests_new RENAME TO pipeline_requests;
        CREATE INDEX pipeline_requests_episode_index ON pipeline_requests(episode_id, created_at DESC);
        INSERT INTO pipeline_runs SELECT * FROM migration_017_pipeline_runs;
        INSERT INTO pipeline_artifacts SELECT * FROM migration_017_pipeline_artifacts;
        INSERT INTO snack_regeneration_proposals SELECT * FROM migration_017_regeneration_proposals;
        DROP TABLE migration_017_pipeline_runs;
        DROP TABLE migration_017_pipeline_artifacts;
        DROP TABLE migration_017_regeneration_proposals;

        CREATE TABLE IF NOT EXISTS publication_snack_metadata (
          snack_revision_id TEXT PRIMARY KEY,
          candidate_id TEXT NOT NULL,
          episode_id TEXT NOT NULL,
          primary_topic TEXT NOT NULL,
          rationale TEXT NOT NULL,
          pipeline_request_id TEXT NOT NULL,
          pipeline_run_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (snack_revision_id) REFERENCES snack_revisions(id) ON DELETE CASCADE,
          FOREIGN KEY (candidate_id) REFERENCES snack_candidates(id) ON DELETE CASCADE,
          FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE,
          FOREIGN KEY (pipeline_request_id) REFERENCES pipeline_requests(id),
          FOREIGN KEY (pipeline_run_id) REFERENCES pipeline_runs(id)
        );

        CREATE INDEX publication_snack_metadata_episode_index
          ON publication_snack_metadata(episode_id, created_at ASC);
      `);
    },
  },
  {
    id: "018_contributor_profiles",
    description: "Add canonical contributor profiles and private identity-photo sources",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS contributors (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          role TEXT NOT NULL,
          short_bio TEXT NOT NULL,
          biography_markdown TEXT NOT NULL,
          aliases_json TEXT NOT NULL DEFAULT '[]',
          external_url TEXT,
          x_url TEXT,
          linkedin_url TEXT,
          nostr_url TEXT,
          reference_photo_path TEXT,
          portrait_path TEXT,
          portrait_status TEXT NOT NULL DEFAULT 'needed' CHECK(portrait_status IN (
            'needed', 'ready-to-generate', 'generating', 'in-review', 'approved', 'failed'
          )),
          source TEXT NOT NULL DEFAULT 'studio' CHECK(source IN ('website', 'studio')),
          created_by_pubkey TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (created_by_pubkey) REFERENCES users(pubkey)
        );

        CREATE INDEX IF NOT EXISTS contributors_name_index ON contributors(name);
      `);

      const now = Date.now();
      const insert = db.query(`INSERT OR IGNORE INTO contributors(
        id, name, role, short_bio, biography_markdown, aliases_json,
        external_url, x_url, linkedin_url, nostr_url, portrait_path,
        portrait_status, source, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'approved', 'website', ?12, ?12)`);
      insert.run(
        'andy-david', 'Andy David', 'Host and co-founder',
        'Co-host of Intelligence Snacks and co-founder of Other Stuff.',
        'Andy explores how AI changes software, organisations and the practical work of building new systems.',
        JSON.stringify(['andy', 'andy david']), null, 'https://x.com/andymdavid',
        'https://www.linkedin.com/in/andymdavid/', 'https://primal.net/andydavid',
        '/images/contributors/andy-david-voxel.webp', now,
      );
      insert.run(
        'pete-winn', 'Pete Winn', 'Host and co-founder',
        'Co-host of Intelligence Snacks and co-founder of Other Stuff.',
        'Pete brings a systems perspective to conversations about agents, software architecture and technological change.',
        JSON.stringify(['pete', 'pete winn']), null, 'https://x.com/Pete_Winn',
        'https://www.linkedin.com/in/pete-winn-otherstuff/', 'https://primal.net/pw',
        '/images/contributors/pete-winn-voxel.webp', now,
      );
      insert.run(
        'dpc', 'dpc', 'Episode 64 guest',
        "Guest participant in Episode 64's conversation about coding agents, software craft and agent harnesses.",
        'Guest participant in the source conversation for the Episode 64 reference material.',
        JSON.stringify(['dpc', 'david']), null, 'https://x.com/dpc_pw', null,
        'https://primal.net/dpc', '/images/contributors/dpc-voxel.webp', now,
      );
    },
  },
  {
    id: "019_contributor_portrait_workflow",
    description: "Add contributor portrait generation jobs and reviewable candidates",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS contributor_portrait_jobs (
          id TEXT PRIMARY KEY,
          contributor_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'prepared' CHECK(status IN (
            'prepared', 'running', 'in-review', 'approved', 'failed'
          )),
          callback_token_hash TEXT NOT NULL,
          autopilot_run_id TEXT,
          failure_summary TEXT,
          prompt_version TEXT NOT NULL,
          model_name TEXT,
          created_by_pubkey TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (contributor_id) REFERENCES contributors(id) ON DELETE CASCADE,
          FOREIGN KEY (created_by_pubkey) REFERENCES users(pubkey)
        );
        CREATE INDEX IF NOT EXISTS contributor_portrait_jobs_contributor_index
          ON contributor_portrait_jobs(contributor_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS contributor_portrait_candidates (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          candidate_number INTEGER NOT NULL CHECK(candidate_number > 0),
          status TEXT NOT NULL DEFAULT 'generated' CHECK(status IN ('generated', 'approved', 'rejected')),
          storage_path TEXT NOT NULL,
          prompt_text TEXT NOT NULL,
          model_name TEXT,
          mime_type TEXT NOT NULL,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          size_bytes INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (job_id) REFERENCES contributor_portrait_jobs(id) ON DELETE CASCADE,
          UNIQUE(job_id, candidate_number)
        );
        CREATE INDEX IF NOT EXISTS contributor_portrait_candidates_job_index
          ON contributor_portrait_candidates(job_id, candidate_number ASC);
      `);
    },
  },
  {
    id: "020_thumbnail_generation_delivery",
    description: "Add authenticated Autopilot delivery state to thumbnail jobs",
    up(db) {
      for (const [column, definition] of [
        ['callback_token_hash', 'TEXT'], ['autopilot_run_id', 'TEXT'], ['failure_summary', 'TEXT'],
        ['generation_round', 'INTEGER NOT NULL DEFAULT 0'],
      ] as const) {
        if (!hasColumn(db, 'thumbnail_jobs', column)) db.exec(`ALTER TABLE thumbnail_jobs ADD COLUMN ${column} ${definition}`);
      }
    },
  },
];

export function applyPendingDbImport(): void {
  const pendingPath = join(DB_IMPORT_DIR, "pending-import.json");
  if (!existsSync(pendingPath)) return;
  const pending = JSON.parse(readFileSync(pendingPath, "utf8")) as { sourcePath?: string; requestedAt?: number };
  if (!pending.sourcePath || !existsSync(pending.sourcePath)) {
    rmSync(pendingPath, { force: true });
    throw new Error(`Pending SQLite import source is missing: ${pending.sourcePath || "(none)"}`);
  }

  mkdirSync(dirname(DB_PATH), { recursive: true });
  mkdirSync(DB_BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (existsSync(DB_PATH)) {
    copyFileSync(DB_PATH, join(DB_BACKUP_DIR, `${stamp}-pre-import-file-copy.sqlite`));
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${DB_PATH}${suffix}`, { force: true });
  }
  copyFileSync(pending.sourcePath, DB_PATH);
  rmSync(pendingPath, { force: true });
}

export function stageDbImport(sourcePath: string): void {
  mkdirSync(DB_IMPORT_DIR, { recursive: true });
  writeFileSync(join(DB_IMPORT_DIR, "pending-import.json"), JSON.stringify({ sourcePath, requestedAt: Date.now() }, null, 2));
}

export function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const appliedRows = db.query("SELECT id FROM schema_migrations").all() as Array<{ id: string }>;
  const applied = new Set(appliedRows.map((row) => row.id));
  const pending = migrations.filter((migration) => !applied.has(migration.id));
  if (!pending.length) return;

  const backupPath = backupDatabase(db, "pre-migration");
  db.exec("BEGIN");
  try {
    for (const migration of pending) {
      migration.up(db);
      db.query("INSERT INTO schema_migrations(id, description, applied_at) VALUES (?1, ?2, ?3)")
        .run(migration.id, migration.description, Date.now());
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  if (backupPath) {
    const filename = backupPath.split("/").at(-1) || backupPath;
    const size = statSync(backupPath).size;
    db.query(`
      INSERT OR IGNORE INTO db_snapshots(id, filename, kind, size_bytes, created_at, note)
      VALUES (?1, ?2, 'pre-migration', ?3, ?4, ?5)
    `).run(crypto.randomUUID(), filename, size, Date.now(), `Automatic backup before ${pending.length} migration(s)`);
  }
}

export function migrationStatus(db: Database) {
  const rows = db.query("SELECT id, description, applied_at FROM schema_migrations ORDER BY applied_at ASC").all() as Array<{
    id: string;
    description: string;
    applied_at: number;
  }>;
  return {
    applied: rows.map((row) => ({ id: row.id, description: row.description, appliedAt: row.applied_at })),
    latest: rows.at(-1)?.id || null,
    available: migrations.map((migration) => ({ id: migration.id, description: migration.description })),
  };
}
