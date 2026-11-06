export function eligibleKnowledgeGraph<T extends { id: string; episodeId: string; sourceTranscriptRevisionId: string; reviewState: string }>(nodes: T[], activeRevision: Map<string,string | null>, publicEpisodeIds: Set<string>) {
  return nodes.filter(node => publicEpisodeIds.has(node.episodeId) && node.reviewState === 'accepted' && activeRevision.get(node.episodeId) === node.sourceTranscriptRevisionId);
}
