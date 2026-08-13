import { mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { db } from "./db.ts";
import { CONTRIBUTOR_UPLOAD_DIR } from "./config.ts";
import type { ContributorProfileInput } from "./contributor-input.ts";
import { recordAuditEvent } from "./episodes.ts";

export type Contributor = ContributorProfileInput & {
  referencePhotoPath: string | null;
  portraitPath: string | null;
  portraitStatus: 'needed' | 'ready-to-generate' | 'generating' | 'in-review' | 'approved' | 'failed';
  source: 'website' | 'studio';
  createdAt: number;
  updatedAt: number;
};

function strings(value: unknown): string[] {
  try { const parsed = JSON.parse(String(value || '[]')); return Array.isArray(parsed) ? parsed.map(String) : []; }
  catch { return []; }
}

function mapContributor(row: Record<string, unknown>): Contributor {
  return {
    id: String(row.id), name: String(row.name), role: String(row.role), shortBio: String(row.short_bio),
    biographyMarkdown: String(row.biography_markdown), aliases: strings(row.aliases_json),
    externalUrl: row.external_url == null ? null : String(row.external_url),
    xUrl: row.x_url == null ? null : String(row.x_url),
    linkedinUrl: row.linkedin_url == null ? null : String(row.linkedin_url),
    nostrUrl: row.nostr_url == null ? null : String(row.nostr_url),
    referencePhotoPath: row.reference_photo_path == null ? null : String(row.reference_photo_path),
    portraitPath: row.portrait_path == null ? null : String(row.portrait_path),
    portraitStatus: String(row.portrait_status) as Contributor['portraitStatus'],
    source: String(row.source) as Contributor['source'], createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

export function listContributors(): Contributor[] {
  return (db.query("SELECT * FROM contributors ORDER BY CASE source WHEN 'website' THEN 0 ELSE 1 END, name COLLATE NOCASE")
    .all() as Record<string, unknown>[]).map(mapContributor);
}

export function getContributor(id: string): Contributor | null {
  const row = db.query('SELECT * FROM contributors WHERE id = ?1').get(id) as Record<string, unknown> | null;
  return row ? mapContributor(row) : null;
}

export async function createContributor(input: ContributorProfileInput & { actorPubkey: string; photo: File }): Promise<Contributor> {
  if (getContributor(input.id)) throw new Error(`Contributor ${input.id} already exists`);
  const extension = input.photo.type === 'image/png' ? '.png' : input.photo.type === 'image/webp' ? '.webp' : '.jpg';
  const directory = join(CONTRIBUTOR_UPLOAD_DIR, input.id);
  const photoPath = join(directory, `identity-source${extension}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(photoPath, new Uint8Array(await input.photo.arrayBuffer()), { flag: 'wx' });
  const now = Date.now();
  db.transaction(() => {
    db.query(`INSERT INTO contributors(
      id, name, role, short_bio, biography_markdown, aliases_json, external_url, x_url,
      linkedin_url, nostr_url, reference_photo_path, portrait_status, source,
      created_by_pubkey, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'ready-to-generate', 'studio', ?12, ?13, ?13)`)
      .run(input.id, input.name, input.role, input.shortBio, input.biographyMarkdown, JSON.stringify(input.aliases),
        input.externalUrl, input.xUrl, input.linkedinUrl, input.nostrUrl, photoPath, input.actorPubkey, now);
    recordAuditEvent({ actorPubkey: input.actorPubkey, action: 'contributor.created', entityType: 'contributor', entityId: input.id, detail: { portraitStatus: 'ready-to-generate' } });
  })();
  return getContributor(input.id)!;
}

export async function updateContributor(id: string, input: ContributorProfileInput & { actorPubkey: string; photo?: File | null }): Promise<Contributor> {
  const existing = getContributor(id);
  if (!existing) throw new Error('Contributor not found');
  let photoPath = existing.referencePhotoPath;
  let portraitStatus = existing.portraitStatus;
  if (input.photo) {
    const extension = input.photo.type === 'image/png' ? '.png' : input.photo.type === 'image/webp' ? '.webp' : '.jpg';
    const directory = join(CONTRIBUTOR_UPLOAD_DIR, id); mkdirSync(directory, { recursive: true });
    photoPath = join(directory, `identity-source-${Date.now()}${extension}`);
    writeFileSync(photoPath, new Uint8Array(await input.photo.arrayBuffer()), { flag: 'wx' });
    portraitStatus = 'ready-to-generate';
  }
  const now = Date.now();
  db.transaction(() => {
    db.query(`UPDATE contributors SET name=?1,role=?2,short_bio=?3,biography_markdown=?4,aliases_json=?5,
      external_url=?6,x_url=?7,linkedin_url=?8,nostr_url=?9,reference_photo_path=?10,portrait_status=?11,updated_at=?12 WHERE id=?13`)
      .run(input.name, input.role, input.shortBio, input.biographyMarkdown, JSON.stringify(input.aliases), input.externalUrl,
        input.xUrl, input.linkedinUrl, input.nostrUrl, photoPath, portraitStatus, now, id);
    recordAuditEvent({ actorPubkey: input.actorPubkey, action: input.photo ? 'contributor.identity-photo.replaced' : 'contributor.updated', entityType: 'contributor', entityId: id });
  })();
  return getContributor(id)!;
}

export function removeContributorPortrait(id: string, actorPubkey: string): Contributor {
  const existing = getContributor(id);
  if (!existing) throw new Error('Contributor not found');
  if (!existing.referencePhotoPath) throw new Error('An identity source photo is required before regenerating a portrait');
  if (existing.portraitStatus === 'generating') throw new Error('Wait for the active portrait generation to finish');
  const now = Date.now();
  db.transaction(() => {
    db.query("UPDATE contributors SET portrait_path=NULL, portrait_status='ready-to-generate', updated_at=?1 WHERE id=?2").run(now, id);
    db.query(`UPDATE thumbnail_jobs SET status='draft', selected_candidate_id=NULL, failure_summary=NULL, updated_at=?1
      WHERE EXISTS (SELECT 1 FROM json_each(thumbnail_jobs.contributor_ids_json) WHERE value=?2)`).run(now, id);
    recordAuditEvent({ actorPubkey, action: 'contributor.portrait.removed', entityType: 'contributor', entityId: id,
      detail: { previousPortraitPath: existing.portraitPath, dependentThumbnailsInvalidated: true } });
  })();
  return getContributor(id)!;
}

export function publicContributor(contributor: Contributor) {
  return {
    ...contributor,
    referencePhotoPath: contributor.referencePhotoPath ? `/api/contributors/${encodeURIComponent(contributor.id)}/reference-photo?v=${contributor.updatedAt}` : null,
    portraitPath: contributor.portraitPath ? `${contributor.portraitPath}?v=${contributor.updatedAt}` : null,
  };
}

export function photoMediaType(path: string): string {
  return extname(path).toLowerCase() === '.png' ? 'image/png' : extname(path).toLowerCase() === '.webp' ? 'image/webp' : 'image/jpeg';
}
