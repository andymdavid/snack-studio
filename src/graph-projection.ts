import { listAllRelationships, listGraphCandidates, type Relationship } from './curation.ts';

type GraphCandidate = ReturnType<typeof listGraphCandidates>[number];
type ProjectionNode = { id: string; label: 'snack' | 'episode'; properties: Record<string, string | number | null> };
type ProjectionEdge = { id: string; from: string; to: string; type: string; properties: Record<string, string | null> };

export function buildApprovedGraphProjection(candidates: GraphCandidate[], relationships: Relationship[]) {
  const candidateById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const nodes = new Map<string, ProjectionNode>(); const edges = new Map<string, ProjectionEdge>();
  for (const candidate of candidates) {
    const snackId = `intelligence-snacks:snack:${candidate.candidateId}`; const episodeId = `intelligence-snacks:episode:${candidate.episodeId}`;
    nodes.set(snackId, { id: snackId, label: 'snack', properties: { candidateId: candidate.candidateId, title: candidate.title, standfirst: candidate.standfirst, episodeId: candidate.episodeId, episodeNumber: candidate.episodeNumber } });
    nodes.set(episodeId, { id: episodeId, label: 'episode', properties: { episodeId: candidate.episodeId, title: candidate.episodeTitle, number: candidate.episodeNumber } });
    edges.set(`${snackId}:derived-from:${episodeId}`, { id: `${snackId}:derived-from:${episodeId}`, from: snackId, to: episodeId, type: 'derived-from', properties: {} });
  }
  for (const relationship of relationships.filter((item) => item.reviewState === 'approved')) {
    if (!candidateById.has(relationship.sourceCandidateId) || !candidateById.has(relationship.targetCandidateId)) continue;
    const from = `intelligence-snacks:snack:${relationship.sourceCandidateId}`; const to = `intelligence-snacks:snack:${relationship.targetCandidateId}`;
    edges.set(`intelligence-snacks:relationship:${relationship.id}`, { id: `intelligence-snacks:relationship:${relationship.id}`, from, to, type: relationship.relationshipType, properties: { relationshipId: relationship.id, explanation: relationship.explanation } });
  }
  return { schemaVersion: '1', source: 'snack-studio', authority: 'intelligence-snacks-editorial', generatedAt: new Date().toISOString(), nodes: [...nodes.values()], edges: [...edges.values()] };
}

export function getApprovedGraphProjection() {
  return buildApprovedGraphProjection(listGraphCandidates(), listAllRelationships());
}
