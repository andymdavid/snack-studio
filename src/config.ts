export const PORT = Number(process.env.PORT || 3000);

function databasePathFromEnv(): string {
  if (process.env.SNACK_STUDIO_DB_PATH) return process.env.SNACK_STUDIO_DB_PATH;
  if (process.env.IS_STUDIO_DB_PATH) return process.env.IS_STUDIO_DB_PATH;
  if (process.env.CHAT_WAPP_DB_PATH) return process.env.CHAT_WAPP_DB_PATH;
  if (process.env.WAPP_DB_PATH) return process.env.WAPP_DB_PATH;
  if (process.env.SQLITE_PATH) return process.env.SQLITE_PATH;
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  if (process.env.DATABASE_URL?.startsWith("file:")) {
    return process.env.DATABASE_URL.slice("file:".length);
  }
  return "data/snack-studio.sqlite";
}

export const DB_PATH = databasePathFromEnv();
export const DB_SNAPSHOT_DIR = process.env.SNACK_STUDIO_DB_SNAPSHOT_DIR || process.env.IS_STUDIO_DB_SNAPSHOT_DIR || process.env.CHAT_WAPP_DB_SNAPSHOT_DIR || "data/snapshots";
export const DB_IMPORT_DIR = process.env.SNACK_STUDIO_DB_IMPORT_DIR || process.env.IS_STUDIO_DB_IMPORT_DIR || process.env.CHAT_WAPP_DB_IMPORT_DIR || "data/imports";
export const DB_BACKUP_DIR = process.env.SNACK_STUDIO_DB_BACKUP_DIR || process.env.IS_STUDIO_DB_BACKUP_DIR || process.env.CHAT_WAPP_DB_BACKUP_DIR || "data/backups";
export const TRANSCRIPT_UPLOAD_DIR = process.env.SNACK_STUDIO_TRANSCRIPT_UPLOAD_DIR || process.env.IS_STUDIO_TRANSCRIPT_UPLOAD_DIR || "data/uploads/transcripts";
export const CONTRIBUTOR_UPLOAD_DIR = process.env.SNACK_STUDIO_CONTRIBUTOR_UPLOAD_DIR || "data/uploads/contributors";
export const INTELLIGENCE_SNACKS_REPO = process.env.SNACK_STUDIO_WEBSITE_REPO || '/workspace/intelligence-snacks';
export const PUBLICATION_WORKTREE_DIR = process.env.SNACK_STUDIO_PUBLICATION_WORKTREE_DIR || 'data/publication-worktrees';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const PIPELINE_NAME = process.env.SNACK_STUDIO_PIPELINE_NAME || process.env.IS_STUDIO_PIPELINE_NAME || process.env.CHAT_WAPP_PIPELINE_NAME || "snack-studio-transcript-to-snacks";
export const WINGMAN_URL = (process.env.WINGMAN_URL || "http://127.0.0.1:3021").replace(/\/$/, "");
export const HTTP_TRIGGER_TOKEN = process.env.WINGMEN_PIPELINE_HTTP_TRIGGER_TOKEN || "";
export const ALLOW_MOCK = (process.env.SNACK_STUDIO_ALLOW_MOCK || process.env.IS_STUDIO_ALLOW_MOCK || process.env.CHAT_WAPP_ALLOW_MOCK) !== "0";
export const PUBLIC_ORIGIN = (process.env.SNACK_STUDIO_PUBLIC_ORIGIN || process.env.IS_STUDIO_PUBLIC_ORIGIN || process.env.CHAT_WAPP_PUBLIC_ORIGIN || "").replace(/\/$/, "");
export const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "snack-studio-local-demo";
export const PIPELINE_TIMEOUT_MS = Math.max(60_000, Number(process.env.SNACK_STUDIO_PIPELINE_TIMEOUT_MS || 30 * 60 * 1000));
export const WAPP_OWNER_NPUB = process.env.WAPP_OWNER_NPUB || "";
export const WAPP_ALLOWED_NPUBS_JSON = process.env.WAPP_ALLOWED_NPUBS_JSON || "[]";
