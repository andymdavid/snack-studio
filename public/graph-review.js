export function deriveGraphReview(payload = {}, filters = {}) {
  const relationships = Array.isArray(payload.relationships) ? payload.relationships : [];
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const candidateById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const normalized = { episodeId: String(filters.episodeId || 'all'), reviewState: String(filters.reviewState || 'all'), relationshipType: String(filters.relationshipType || 'all'), query: String(filters.query || '').trim().toLocaleLowerCase() };
  const visible = relationships.filter((relationship) => {
    const source = candidateById.get(relationship.sourceCandidateId); const target = candidateById.get(relationship.targetCandidateId);
    if (normalized.episodeId !== 'all' && source?.episodeId !== normalized.episodeId) return false;
    if (normalized.reviewState !== 'all' && relationship.reviewState !== normalized.reviewState) return false;
    if (normalized.relationshipType !== 'all' && relationship.relationshipType !== normalized.relationshipType) return false;
    if (normalized.query) {
      const searchable = [relationship.sourceTitle, relationship.targetTitle, relationship.explanation, relationship.evidenceExcerpt, source?.episodeTitle, target?.episodeTitle].filter(Boolean).join(' ').toLocaleLowerCase();
      if (!searchable.includes(normalized.query)) return false;
    }
    return true;
  });
  const groupMap = new Map();
  for (const relationship of visible) {
    const source = candidateById.get(relationship.sourceCandidateId) || { candidateId: relationship.sourceCandidateId, title: relationship.sourceTitle };
    const existing = groupMap.get(relationship.sourceCandidateId) || { source, relationships: [] };
    existing.relationships.push({ ...relationship, source, target: candidateById.get(relationship.targetCandidateId) || null }); groupMap.set(relationship.sourceCandidateId, existing);
  }
  const reviewed = relationships.filter((relationship) => relationship.reviewState !== 'draft').length;
  const episodes = [...new Map(candidates.map((candidate) => [candidate.episodeId, { id: candidate.episodeId, number: candidate.episodeNumber, title: candidate.episodeTitle }])).values()].sort((a, b) => Number(b.number || 0) - Number(a.number || 0));
  return { filters: normalized, total: relationships.length, reviewed, drafts: relationships.length - reviewed, visibleCount: visible.length, groups: [...groupMap.values()], episodes };
}

export function deriveGraphFocus(payload = {}, candidateId = '', options = {}) {
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const relationships = Array.isArray(payload.relationships) ? payload.relationships : [];
  const candidateById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const eligible = relationships.filter((relationship) => relationship.reviewState === 'approved' || (options.includeDrafts && relationship.reviewState === 'draft'));
  const degree = new Map();
  for (const relationship of eligible) for (const id of [relationship.sourceCandidateId, relationship.targetCandidateId]) degree.set(id, (degree.get(id) || 0) + 1);
  const selectedId = candidateById.has(candidateId) ? candidateId : [...degree.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || candidates[0]?.candidateId || '';
  const focus = candidateById.get(selectedId) || null;
  const connections = eligible.filter((relationship) => relationship.sourceCandidateId === selectedId || relationship.targetCandidateId === selectedId).map((relationship) => {
    const outgoing = relationship.sourceCandidateId === selectedId;
    const neighbourId = outgoing ? relationship.targetCandidateId : relationship.sourceCandidateId;
    return { relationship, direction: outgoing ? 'outgoing' : 'incoming', neighbour: candidateById.get(neighbourId) || { candidateId: neighbourId, title: outgoing ? relationship.targetTitle : relationship.sourceTitle } };
  }).sort((a, b) => String(a.neighbour.title).localeCompare(String(b.neighbour.title)));
  return { focus, connections, approvedCount: relationships.filter((relationship) => relationship.reviewState === 'approved').length, draftCount: relationships.filter((relationship) => relationship.reviewState === 'draft').length, candidates: [...candidates].sort((a, b) => String(a.title).localeCompare(String(b.title))) };
}
