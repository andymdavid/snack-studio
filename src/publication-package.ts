import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { db } from './db.ts';
import { INTELLIGENCE_SNACKS_REPO } from './config.ts';
import { getCandidate, validateApprovedCandidateBatch } from './candidates.ts';
import { getContributor } from './contributors.ts';
import { getActiveTranscriptRevision, getEpisode } from './episodes.ts';
import { resolveTranscriptParticipants } from './publication-metadata.ts';
import { getTheme } from './themes.ts';
import { getApprovedPublicTranscript } from './public-transcripts.ts';
import { listNewsletterItems, listRelationships } from './curation.ts';

export type PublicationPackageFile = {
  kind: 'episode' | 'snack' | 'person' | 'theme' | 'newsletter' | 'transcript' | 'episode-thumbnail' | 'snack-thumbnail' | 'person-portrait';
  destination: string;
  sourceId: string;
  sourceRevisionId?: string;
  sourcePath?: string;
  sizeBytes?: number;
};

export type PublicationBlocker = { code: string; message: string; sourceId?: string };

export function publicationSlug(value: string) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);
}

export function episodePublicationSlug(number: number) {
  return `episode-${String(number).padStart(3, '0')}`;
}

export function episodePublicTitle(title: string, episodeNumber: number | null) {
  if (!episodeNumber) return title.trim();
  return title.trim().replace(new RegExp(`^episode\\s+${episodeNumber}\\s*[:\\-–—]\\s*`, 'i'), '').trim() || title.trim();
}

export function resolvePublicationAssetSource(path: string) {
  if (path.startsWith('/images/')) return resolve('public', path.slice(1));
  return isAbsolute(path) ? path : resolve(path);
}

export function websiteThemeNeedsPublication(themeId: string, websiteRepo = INTELLIGENCE_SNACKS_REPO) {
  return !existsSync(join(websiteRepo, 'src/content/topics', `${themeId}.md`));
}

function selectedFinishedAsset(jobId: string) {
  return db.query(`SELECT a.* FROM thumbnail_assets a
    JOIN thumbnail_jobs j ON j.id=a.job_id
    WHERE a.job_id=?1 AND a.asset_stage='finished' AND a.candidate_id=j.selected_candidate_id
    ORDER BY a.version_number DESC LIMIT 1`).get(jobId) as Record<string, unknown> | null;
}

export function buildPublicationPackage(episodeId: string) {
  const episode = getEpisode(episodeId);
  if (!episode) throw new Error('Episode not found');
  const transcript = getActiveTranscriptRevision(episodeId);
  const publicTranscript = getApprovedPublicTranscript(episodeId);
  const approved = validateApprovedCandidateBatch(episodeId);
  const blockers: PublicationBlocker[] = [];
  if (episode.status !== 'approved') blockers.push({ code: 'episode-not-approved', message: 'Approve the final Snack set before preparing the website package.' });
  if (!episode.episodeNumber) blockers.push({ code: 'episode-number-missing', message: 'The episode needs a publication number.' });
  if (!transcript) blockers.push({ code: 'transcript-missing', message: 'The episode needs an active transcript revision.' });
  if (!publicTranscript) blockers.push({ code: 'public-transcript-missing', message: 'Review and approve the cleaned public transcript.' });
  for (const check of approved.checks.filter((item) => !item.ok)) blockers.push({ code: `approved-${check.key}`, message: check.message });

  const episodeNumber = episode.episodeNumber || 0;
  const episodeSlug = episodeNumber ? episodePublicationSlug(episodeNumber) : 'episode-unassigned';
  const participants = transcript ? resolveTranscriptParticipants(transcript.transcriptText) : { resolved: [], unresolved: [] };
  for (const name of participants.unresolved) blockers.push({ code: 'participant-unresolved', message: `Resolve contributor ${name}.` });
  const contributorIds = participants.resolved.map((item) => item.contributorId);
  const people = contributorIds.map(getContributor).filter(Boolean).map((person) => ({
    id: person!.id, name: person!.name, role: person!.role, shortBio: person!.shortBio,
    biographyMarkdown: person!.biographyMarkdown, image: `/images/${person!.id}-voxel.webp`,
    externalUrl: person!.externalUrl, socialLinks: { x: person!.xUrl, linkedin: person!.linkedinUrl, nostr: person!.nostrUrl },
    source: person!.source, portraitPath: person!.portraitPath,
  }));
  for (const person of people) if (!person.portraitPath) blockers.push({ code: 'portrait-missing', message: `${person.name} needs an approved portrait.`, sourceId: person.id });

  const files: PublicationPackageFile[] = [];
  if (episodeNumber) files.push({ kind: 'episode', destination: `src/content/episodes/${episodeSlug}.md`, sourceId: episode.id });
  if (publicTranscript && episodeNumber) files.push({ kind: 'transcript', destination: `src/content/transcripts/${episodeSlug}.txt`, sourceId: publicTranscript.id, sourceRevisionId: publicTranscript.sourceTranscriptRevisionId, sizeBytes: new TextEncoder().encode(publicTranscript.transcriptText).byteLength });
  for (const person of people.filter((item) => item.source === 'studio')) {
    files.push({ kind: 'person', destination: `src/content/people/${person.id}.md`, sourceId: person.id });
    if (person.portraitPath) files.push({ kind: 'person-portrait', destination: `public/images/${person.id}-voxel.webp`, sourceId: person.id, sourcePath: resolvePublicationAssetSource(person.portraitPath) });
  }
  const episodeThemeRows = db.query('SELECT theme_id,rationale,evidence_excerpt FROM episode_theme_assignments WHERE episode_id=?1 ORDER BY created_at,theme_id').all(episodeId) as Array<{ theme_id: string; rationale: string; evidence_excerpt: string }>;
  const themes = episodeThemeRows.map((row) => ({ ...getTheme(row.theme_id)!, rationale: row.rationale, evidenceExcerpt: row.evidence_excerpt })).filter((item) => item.id);
  if (!themes.length) blockers.push({ code: 'episode-themes-missing', message: 'Episode themes need to be derived from the transcript.' });
  for (const theme of themes.filter((item) => websiteThemeNeedsPublication(item.id))) {
    files.push({ kind: 'theme', destination: `src/content/topics/${theme.id}.md`, sourceId: theme.id });
  }

  const snacks = approved.candidateIds.map(getCandidate).filter(Boolean).map((candidate) => {
    const revision = candidate!.revision;
    const assignment = db.query('SELECT theme_id FROM snack_theme_assignments WHERE snack_revision_id=?1').get(revision.id) as { theme_id: string } | null;
    const theme = assignment?.theme_id || '';
    const slug = publicationSlug(revision.publicTitle);
    if (!slug) blockers.push({ code: 'snack-slug-missing', message: `Could not derive a slug for ${revision.publicTitle}.`, sourceId: candidate!.id });
    if (!theme) blockers.push({ code: 'snack-theme-missing', message: `${revision.publicTitle} needs one theme from the episode.`, sourceId: candidate!.id });
    const job = db.query("SELECT * FROM thumbnail_jobs WHERE episode_id=?1 AND asset_kind='snack' AND snack_revision_id=?2 ORDER BY created_at DESC LIMIT 1")
      .get(episodeId, revision.id) as Record<string, unknown> | null;
    const asset = job && String(job.status) === 'approved' ? selectedFinishedAsset(String(job.id)) : null;
    if (!asset) blockers.push({ code: 'snack-thumbnail-missing', message: `${revision.publicTitle} needs an approved finished thumbnail.`, sourceId: candidate!.id });
    files.push({ kind: 'snack', destination: `src/content/snacks/${slug || candidate!.id}.md`, sourceId: candidate!.id, sourceRevisionId: revision.id });
    if (asset) files.push({ kind: 'snack-thumbnail', destination: `public/images/snacks/${slug}.webp`, sourceId: candidate!.id, sourceRevisionId: revision.id, sourcePath: String(asset.storage_path), sizeBytes: Number(asset.size_bytes) });
    return {
      candidateId: candidate!.id, revisionId: revision.id, position: candidate!.approvedPosition,
      slug, title: revision.publicTitle, editorialTitle: revision.editorialTitle, standfirst: revision.standfirst,
      bodyMarkdown: revision.bodyMarkdown, attribution: revision.attribution || `Developed from a conversation between ${people.map((person) => person.name).join(', ').replace(/, ([^,]*)$/, ' and $1')}`,
      theme,
      transcriptStart: revision.transcriptTimestamp, seo: { title: revision.seoTitle, description: revision.seoDescription },
      thumbnail: asset ? `/images/snacks/${slug}.webp` : null,
    };
  });
  const snackSlugs = new Map(snacks.map((snack) => [snack.candidateId, snack.slug]));
  const newsletterItems = listNewsletterItems(episodeId);
  if (newsletterItems.length < 3 || newsletterItems.length > 4) blockers.push({ code: 'newsletter-selection-incomplete', message: 'Select three or four Snacks for the newsletter edition.' });
  const newsletter = newsletterItems.length ? { slug: episodeSlug, title: `Intelligence Snacks ${episodeNumber}`, sourceEpisode: episodeSlug, snacks: newsletterItems.map((item) => snackSlugs.get(item.candidateId) || '').filter(Boolean) } : null;
  if (newsletter && episodeNumber) files.push({ kind: 'newsletter', destination: `src/content/newsletters/${episodeSlug}.md`, sourceId: episode.id });

  const relationships = listRelationships(episodeId).filter((item) => item.reviewState === 'approved').map((item) => ({
    sourceCandidateId: item.sourceCandidateId, targetCandidateId: item.targetCandidateId,
    sourceSlug: publicationSlug(getCandidate(item.sourceCandidateId)?.revision.publicTitle || ''), targetSlug: publicationSlug(getCandidate(item.targetCandidateId)?.revision.publicTitle || ''),
    type: item.relationshipType, note: item.explanation,
  }));

  const episodeJob = db.query("SELECT * FROM thumbnail_jobs WHERE episode_id=?1 AND asset_kind='episode' ORDER BY created_at DESC LIMIT 1").get(episodeId) as Record<string, unknown> | null;
  const episodeAsset = episodeJob && String(episodeJob.status) === 'approved' ? selectedFinishedAsset(String(episodeJob.id)) : null;
  if (!episodeAsset) blockers.push({ code: 'episode-thumbnail-missing', message: 'The episode needs an approved finished thumbnail.' });
  if (episodeAsset && episodeNumber) files.push({ kind: 'episode-thumbnail', destination: `public/images/episodes/${episodeSlug}-thumbnail.webp`, sourceId: episode.id, sourcePath: String(episodeAsset.storage_path), sizeBytes: Number(episodeAsset.size_bytes) });

  const summary = episode.publicSummary?.trim() || snacks.slice(0, 2).map((snack) => snack.standfirst.trim()).filter(Boolean).join(' ').slice(0, 500);
  const duplicateDestinations = files.map((file) => file.destination).filter((path, index, all) => all.indexOf(path) !== index);
  for (const destination of new Set(duplicateDestinations)) blockers.push({ code: 'destination-collision', message: `More than one package item targets ${destination}.` });
  const packageValue = {
    schemaVersion: 1,
    episode: {
      id: episode.id, slug: episodeSlug, number: episode.episodeNumber, title: episodePublicTitle(episode.workingTitle, episode.episodeNumber),
      summary, status: 'published', participants: contributorIds, themes: themes.map((theme) => theme.id),
      recordedOn: episode.recordedOn, audioUrl: episode.audioUrl, youtubeUrl: episode.videoUrl,
      transcript: publicTranscript && episodeNumber ? episodeSlug : null,
      thumbnail: episodeAsset && episodeNumber ? `/images/episodes/${episodeSlug}-thumbnail.webp` : null,
    },
    snacks, people, themes, newsletter, relationships, transcript: publicTranscript ? { id: publicTranscript.id, sourceRevisionId: publicTranscript.sourceTranscriptRevisionId, status: publicTranscript.status, transcriptText: publicTranscript.transcriptText } : null,
    files: files.sort((a, b) => a.destination.localeCompare(b.destination)),
  };
  const fingerprint = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(packageValue))));
  return { ...packageValue, fingerprint, ready: blockers.length === 0, blockers };
}
