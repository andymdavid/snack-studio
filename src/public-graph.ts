import type { Database } from 'bun:sqlite';
import { db as appDb } from './db.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { INTELLIGENCE_SNACKS_REPO } from './config.ts';
import { listAllRelationships, listGraphCandidates, listGraphContributors } from './curation.ts';
import { listKnowledgeGraph } from './knowledge-graph.ts';
import { listTranscriptTopicIndex } from './discussion-topics.ts';

const publicationSlug = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);
const episodePublicationSlug = (number: number) => `episode-${String(number).padStart(3, '0')}`;

export function buildPublicGraphDataset(currentEpisodeId: string, database: Database = appDb) {
  const episodeRows = database.query("SELECT id,episode_number FROM episodes WHERE status IN ('approved','published') OR id=?1").all(currentEpisodeId) as Array<{ id: string; episode_number: number | null }>;
  const publicEpisodeIds = new Set(episodeRows.filter((episode) => episode.id === currentEpisodeId || Boolean(episode.episode_number && existsSync(join(INTELLIGENCE_SNACKS_REPO, 'src/content/episodes', `${episodePublicationSlug(episode.episode_number)}.md`)))).map((episode) => episode.id));
  const candidates = listGraphCandidates().filter((candidate) => publicEpisodeIds.has(candidate.episodeId)).map((candidate) => ({
    ...candidate,
    href: `/snacks/${publicationSlug(candidate.title)}/`,
    episodeHref: candidate.episodeNumber ? `/episodes/${episodePublicationSlug(candidate.episodeNumber)}/` : null,
  }));
  const candidateIds = new Set(candidates.map((candidate) => candidate.candidateId));
  const contributors = listGraphContributors().map((contributor) => ({ ...contributor, episodeIds: contributor.episodeIds.filter((id) => publicEpisodeIds.has(id)), href: `/contributors/${contributor.contributorId}/` })).filter((contributor) => contributor.episodeIds.length);
  const knowledge = listKnowledgeGraph();
  const publicNodeIds = new Set(knowledge.nodes.filter((node) => publicEpisodeIds.has(node.episodeId)).map((node) => node.id));
  const topicIndex = listTranscriptTopicIndex();
  const publicPassages = topicIndex.passages.filter((passage) => publicEpisodeIds.has(passage.episodeId));
  const usedTopicIds = new Set(publicPassages.flatMap((passage) => [passage.primaryTopicId, ...(passage.secondaryTopicIds || [])]));
  const topicById = new Map(topicIndex.topics.map((topic) => [topic.id, topic]));
  for (const id of [...usedTopicIds]) { const parentId = topicById.get(id)?.parentTopicId; if (parentId) usedTopicIds.add(parentId); }
  return {
    schemaVersion: 1,
    candidates,
    contributors,
    relationships: listAllRelationships().filter((relationship) => relationship.reviewState === 'approved' && candidateIds.has(relationship.sourceCandidateId) && candidateIds.has(relationship.targetCandidateId)),
    knowledge: {
      nodes: knowledge.nodes.filter((node) => publicNodeIds.has(node.id)),
      edges: knowledge.edges.filter((edge) => edge.reviewState !== 'rejected' && publicNodeIds.has(edge.sourceNodeId) && publicNodeIds.has(edge.targetNodeId)),
      snackLinks: knowledge.snackLinks.filter((link) => link.reviewState !== 'rejected' && publicNodeIds.has(link.knowledgeNodeId) && candidateIds.has(link.candidateId)),
    },
    topicIndex: {
      topics: topicIndex.topics.filter((topic) => usedTopicIds.has(topic.id)),
      analyses: topicIndex.analyses.filter((analysis) => publicEpisodeIds.has(analysis.episodeId)),
      passages: publicPassages,
    },
  };
}
