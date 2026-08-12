import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { db } from './db.ts';
import { getCandidate, validateApprovedCandidateBatch } from './candidates.ts';
import { getContributor } from './contributors.ts';
import { getActiveTranscriptRevision, getEpisode } from './episodes.ts';
import { resolveCanonicalTopic, resolveTranscriptParticipants } from './publication-metadata.ts';

export type PublicationPackageFile = {
  kind: 'episode' | 'snack' | 'person' | 'transcript' | 'episode-thumbnail' | 'snack-thumbnail' | 'person-portrait';
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
  const approved = validateApprovedCandidateBatch(episodeId);
  const blockers: PublicationBlocker[] = [];
  if (episode.status !== 'approved') blockers.push({ code: 'episode-not-approved', message: 'Approve the final Snack set before preparing the website package.' });
  if (!episode.episodeNumber) blockers.push({ code: 'episode-number-missing', message: 'The episode needs a publication number.' });
  if (!episode.publicTitle?.trim()) blockers.push({ code: 'episode-title-missing', message: 'The episode needs a public title.' });
  if (!episode.publicSummary?.trim()) blockers.push({ code: 'episode-summary-missing', message: 'The episode needs a public summary.' });
  const explicitEpisodeTopic = resolveCanonicalTopic(episode.primaryTopic)?.id || '';
  if (!explicitEpisodeTopic) blockers.push({ code: 'episode-topic-missing', message: 'The episode needs a canonical primary topic.' });
  if (!transcript) blockers.push({ code: 'transcript-missing', message: 'The episode needs an active transcript revision.' });
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
  if (transcript && episodeNumber) files.push({ kind: 'transcript', destination: `src/content/transcripts/${episodeSlug}.txt`, sourceId: transcript.id, sourceRevisionId: transcript.id, sizeBytes: transcript.sizeBytes });
  for (const person of people.filter((item) => item.source === 'studio')) {
    files.push({ kind: 'person', destination: `src/content/people/${person.id}.md`, sourceId: person.id });
    if (person.portraitPath) files.push({ kind: 'person-portrait', destination: `public/images/${person.id}-voxel.webp`, sourceId: person.id, sourcePath: person.portraitPath });
  }

  const snacks = approved.candidateIds.map(getCandidate).filter(Boolean).map((candidate) => {
    const revision = candidate!.revision;
    const storedTopic = db.query('SELECT primary_topic FROM publication_snack_metadata WHERE snack_revision_id=?1').get(revision.id) as { primary_topic: string } | null;
    const primaryTopic = resolveCanonicalTopic(storedTopic?.primary_topic || revision.primaryTopic)?.id || '';
    const slug = publicationSlug(revision.publicTitle);
    if (!slug) blockers.push({ code: 'snack-slug-missing', message: `Could not derive a slug for ${revision.publicTitle}.`, sourceId: candidate!.id });
    if (!primaryTopic) blockers.push({ code: 'snack-topic-missing', message: `${revision.publicTitle} needs a canonical primary topic.`, sourceId: candidate!.id });
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
      primaryTopic,
      relatedTopics: revision.relatedTopics.map((topic) => resolveCanonicalTopic(topic)?.id).filter(Boolean),
      transcriptStart: revision.transcriptTimestamp, seo: { title: revision.seoTitle, description: revision.seoDescription },
      thumbnail: asset ? `/images/snacks/${slug}.webp` : null,
    };
  });

  const episodeJob = db.query("SELECT * FROM thumbnail_jobs WHERE episode_id=?1 AND asset_kind='episode' ORDER BY created_at DESC LIMIT 1").get(episodeId) as Record<string, unknown> | null;
  const episodeAsset = episodeJob && String(episodeJob.status) === 'approved' ? selectedFinishedAsset(String(episodeJob.id)) : null;
  if (!episodeAsset) blockers.push({ code: 'episode-thumbnail-missing', message: 'The episode needs an approved finished thumbnail.' });
  if (episodeAsset && episodeNumber) files.push({ kind: 'episode-thumbnail', destination: `public/images/episodes/${episodeSlug}-thumbnail.webp`, sourceId: episode.id, sourcePath: String(episodeAsset.storage_path), sizeBytes: Number(episodeAsset.size_bytes) });

  const primaryTopic = explicitEpisodeTopic;
  const duplicateDestinations = files.map((file) => file.destination).filter((path, index, all) => all.indexOf(path) !== index);
  for (const destination of new Set(duplicateDestinations)) blockers.push({ code: 'destination-collision', message: `More than one package item targets ${destination}.` });
  const packageValue = {
    schemaVersion: 1,
    episode: {
      id: episode.id, slug: episodeSlug, number: episode.episodeNumber, title: episode.publicTitle || episode.workingTitle,
      summary: episode.publicSummary, status: 'published', participants: contributorIds, primaryTopic,
      relatedTopics: [...new Set(snacks.flatMap((snack) => snack.relatedTopics))].filter((topic) => topic !== primaryTopic),
      recordedOn: episode.recordedOn, audioUrl: episode.audioUrl, youtubeUrl: episode.videoUrl,
      transcript: transcript && episodeNumber ? episodeSlug : null,
      thumbnail: episodeAsset && episodeNumber ? `/images/episodes/${episodeSlug}-thumbnail.webp` : null,
    },
    snacks, people, transcript: transcript ? { revisionId: transcript.id, sha256: transcript.sha256, sizeBytes: transcript.sizeBytes } : null,
    files: files.sort((a, b) => a.destination.localeCompare(b.destination)),
  };
  const fingerprint = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(packageValue))));
  return { ...packageValue, fingerprint, ready: blockers.length === 0, blockers };
}
