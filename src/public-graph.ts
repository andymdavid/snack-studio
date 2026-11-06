import { listCanonicalConcepts } from './canonical-concepts.ts';
import type { Database } from 'bun:sqlite';
import { db as appDb } from './db.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { INTELLIGENCE_SNACKS_REPO } from './config.ts';
import { listAllRelationships, listGraphCandidates, listGraphContributors } from './curation.ts';
import { listKnowledgeGraph } from './knowledge-graph.ts';
import { eligibleKnowledgeGraph } from './public-graph-policy.ts';
import { readPublishedSnacks, resolvePublishedSnack } from './published-manifest.ts';
import { listTranscriptTopicIndex } from './discussion-topics.ts';

const publicationSlug = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);
const episodePublicationSlug = (number: number) => `episode-${String(number).padStart(3, '0')}`;

export function buildPublicGraphDataset(currentEpisodeId: string, database: Database = appDb, websiteRepo = INTELLIGENCE_SNACKS_REPO) {
  const episodeRows = database.query("SELECT id,episode_number,active_transcript_revision_id FROM episodes WHERE status IN ('approved','published') OR id=?1").all(currentEpisodeId) as Array<{ id: string; episode_number: number | null; active_transcript_revision_id: string | null }>;
  const publicEpisodeIds = new Set(episodeRows.filter((episode) => episode.id === currentEpisodeId || Boolean(episode.episode_number && existsSync(join(websiteRepo, 'src/content/episodes', `${episodePublicationSlug(episode.episode_number)}.md`)))).map((episode) => episode.id));
  const manifest = readPublishedSnacks(websiteRepo);
  const candidates = listGraphCandidates(database).filter((candidate) => publicEpisodeIds.has(candidate.episodeId)).flatMap((candidate) => {
    const published = candidate.episodeId === currentEpisodeId ? null : resolvePublishedSnack(candidate, manifest);
    if (!published && candidate.episodeId !== currentEpisodeId) return [];
    if (published?.revisionId) {
      const row = database.query('SELECT current_revision_id FROM snack_candidates WHERE id=?1').get(candidate.candidateId) as { current_revision_id: string };
      if (row.current_revision_id !== published.revisionId && candidate.episodeId !== currentEpisodeId) throw new Error(`Published Snack revision differs from Studio: ${candidate.candidateId}`);
    }
    return [{ ...candidate, title: published?.title || candidate.title, standfirst: published?.standfirst || candidate.standfirst,
      href: `/snacks/${published?.slug || publicationSlug(candidate.title)}/`,
      episodeHref: candidate.episodeNumber ? `/episodes/${episodePublicationSlug(candidate.episodeNumber)}/` : null }];
  });
  const candidateIds = new Set(candidates.map((candidate) => candidate.candidateId));
  const contributors = listGraphContributors(database).map((contributor) => ({ ...contributor, episodeIds: contributor.episodeIds.filter((id) => publicEpisodeIds.has(id)), href: `/contributors/${contributor.contributorId}/` })).filter((contributor) => contributor.episodeIds.length);
  const knowledge = listKnowledgeGraph(undefined, database);
  const activeRevision = new Map(episodeRows.map((episode) => [episode.id, episode.active_transcript_revision_id]));
  const publicNodeIds = new Set(eligibleKnowledgeGraph(knowledge.nodes, activeRevision, publicEpisodeIds).map((node) => node.id));
  const topicIndex = listTranscriptTopicIndex(database);
  const publicPassages = topicIndex.passages.filter((passage) => publicEpisodeIds.has(passage.episodeId) && activeRevision.get(passage.episodeId) === passage.transcriptRevisionId);
  const usedTopicIds = new Set(publicPassages.flatMap((passage) => [passage.primaryTopicId, ...(passage.secondaryTopicIds || [])]));
  const topicById = new Map(topicIndex.topics.map((topic) => [topic.id, topic]));
  for (const id of [...usedTopicIds]) { const parentId = topicById.get(id)?.parentTopicId; if (parentId) usedTopicIds.add(parentId); }
  const registry = listCanonicalConcepts(database);
  const conceptRegistry = { ...registry, concepts: registry.concepts.filter(concept => concept.reviewState === 'accepted').map(concept => ({...concept, mentions: concept.mentions.filter(id => publicNodeIds.has(id))})).filter(concept => concept.mentions.length) };
  return {
    ...(conceptRegistry.concepts.length ? { conceptRegistry } : {}),
    schemaVersion: 1,
    publicationPolicy: { version: 2, knowledgeAcceptance: 'automated-exact-evidence-validation', humanReviewImplied: false },
    episodes: episodeRows.filter((episode) => publicEpisodeIds.has(episode.id)).map((episode) => ({ episodeId: episode.id, episodeNumber: episode.episode_number, href: `/episodes/${episodePublicationSlug(episode.episode_number!)}/` })),
    candidates,
    contributors,
    relationships: listAllRelationships(database).filter((relationship) => relationship.reviewState === 'approved' && candidateIds.has(relationship.sourceCandidateId) && candidateIds.has(relationship.targetCandidateId)),
    knowledge: {
      nodes: knowledge.nodes.filter((node) => publicNodeIds.has(node.id)),
      edges: knowledge.edges.filter((edge) => edge.reviewState === 'accepted' && publicNodeIds.has(edge.sourceNodeId) && publicNodeIds.has(edge.targetNodeId)),
      snackLinks: knowledge.snackLinks.filter((link) => link.reviewState === 'accepted' && publicNodeIds.has(link.knowledgeNodeId) && candidateIds.has(link.candidateId)),
    },
    topicIndex: {
      topics: topicIndex.topics.filter((topic) => usedTopicIds.has(topic.id)),
      analyses: topicIndex.analyses.filter((analysis) => publicEpisodeIds.has(analysis.episodeId) && activeRevision.get(analysis.episodeId) === analysis.transcriptRevisionId),
      passages: publicPassages,
    },
  };
}
