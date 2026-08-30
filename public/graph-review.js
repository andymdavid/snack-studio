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

export function deriveKnowledgeFocus(payload = {}, requestedId = '') {
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const contributors = Array.isArray(payload.contributors) ? payload.contributors : [];
  const knowledge = payload.knowledge && typeof payload.knowledge === 'object' ? payload.knowledge : {};
  const knowledgeNodes = Array.isArray(knowledge.nodes) ? knowledge.nodes : [];
  const episodeById = new Map(candidates.map((candidate) => [candidate.episodeId, { number: candidate.episodeNumber, title: candidate.episodeTitle }]));
  const episodes = [...new Map(candidates.map((candidate) => [candidate.episodeId, { id: candidate.episodeId, number: candidate.episodeNumber, title: candidate.episodeTitle }])).values()];
  const nodes = [
    { id: 'root:intelligence-snacks', entityId: 'intelligence-snacks', kind: 'root', title: 'Intelligence Snacks', summary: 'The people, episodes and ideas developed across Intelligence Snacks.', episodeId: '', episodeNumber: null, episodeTitle: '', evidence: [] },
    ...episodes.map((episode) => ({ id: `episode:${episode.id}`, entityId: episode.id, kind: 'episode', title: `Episode ${episode.number || '—'} · ${episode.title}`, summary: episode.title, episodeId: episode.id, episodeNumber: episode.number, episodeTitle: episode.title, evidence: [] })),
    ...contributors.map((contributor) => ({ id: `contributor:${contributor.contributorId}`, entityId: contributor.contributorId, kind: /\bhost\b/i.test(contributor.role || '') ? 'host' : 'contributor', role: contributor.role || '', title: contributor.name, summary: contributor.shortBio || contributor.role || 'Intelligence Snacks contributor', episodeId: '', episodeNumber: null, episodeTitle: '', aliases: contributor.aliases || [], evidence: [] })),
    ...candidates.map((candidate) => ({ id: `snack:${candidate.candidateId}`, entityId: candidate.candidateId, kind: 'snack', title: candidate.title, summary: candidate.standfirst || '', episodeId: candidate.episodeId, episodeNumber: candidate.episodeNumber, episodeTitle: candidate.episodeTitle, evidence: [] })),
    ...knowledgeNodes.map((node) => ({ id: `knowledge:${node.id}`, entityId: node.id, kind: node.kind, title: node.title, summary: node.summary, episodeId: node.episodeId, episodeNumber: episodeById.get(node.episodeId)?.number || null, episodeTitle: episodeById.get(node.episodeId)?.title || '', confidence: node.confidence, evidence: Array.isArray(node.evidence) ? node.evidence : [] })),
  ];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const connections = [];
  for (const episode of episodes) connections.push({ id: `root-episode:${episode.id}`, sourceId: 'root:intelligence-snacks', targetId: `episode:${episode.id}`, relationshipType: 'contains', explanation: '', confidence: 1, editable: false });
  for (const candidate of candidates) connections.push({ id: `episode-snack:${candidate.candidateId}`, sourceId: `episode:${candidate.episodeId}`, targetId: `snack:${candidate.candidateId}`, relationshipType: 'publishes', explanation: '', confidence: 1, editable: false });
  for (const contributor of contributors) { const isHost = /\bhost\b/i.test(contributor.role || ''); connections.push({ id: `root-contributor:${contributor.contributorId}`, sourceId: 'root:intelligence-snacks', targetId: `contributor:${contributor.contributorId}`, relationshipType: isHost ? 'hosted-by' : 'features', explanation: '', confidence: 1, editable: false }); for (const episodeId of contributor.episodeIds || []) connections.push({ id: `contributor-episode:${contributor.contributorId}:${episodeId}`, sourceId: `contributor:${contributor.contributorId}`, targetId: `episode:${episodeId}`, relationshipType: isHost ? 'hosted' : 'contributed-to', explanation: '', confidence: 1, editable: false }); }
  for (const relationship of Array.isArray(payload.relationships) ? payload.relationships : []) if (relationship.reviewState !== 'rejected') connections.push({ id: `snack-relationship:${relationship.id}`, sourceId: `snack:${relationship.sourceCandidateId}`, targetId: `snack:${relationship.targetCandidateId}`, relationshipType: relationship.relationshipType, explanation: relationship.explanation || '', confidence: null, editable: true, relationship });
  for (const edge of Array.isArray(knowledge.edges) ? knowledge.edges : []) if (edge.reviewState !== 'rejected') connections.push({ id: `knowledge-edge:${edge.id}`, sourceId: `knowledge:${edge.sourceNodeId}`, targetId: `knowledge:${edge.targetNodeId}`, relationshipType: edge.relationshipType, explanation: edge.explanation || '', confidence: edge.confidence, editable: false, relationship: edge });
  for (const link of Array.isArray(knowledge.snackLinks) ? knowledge.snackLinks : []) if (link.reviewState !== 'rejected') connections.push({ id: `knowledge-snack:${link.id}`, sourceId: `knowledge:${link.knowledgeNodeId}`, targetId: `snack:${link.candidateId}`, relationshipType: link.relationshipType, explanation: '', confidence: link.confidence, editable: false, relationship: link });
  const normalize = (value) => String(value || '').trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const contributorBySpeaker = new Map(); for (const contributor of contributors) for (const label of [contributor.name, ...(contributor.aliases || [])]) if (normalize(label)) contributorBySpeaker.set(normalize(label), contributor.contributorId);
  for (const node of knowledgeNodes) for (const speaker of new Set((node.evidence || []).map((item) => normalize(item.speaker)).filter(Boolean))) { const contributorId = contributorBySpeaker.get(speaker); if (contributorId) connections.push({ id: `contributor-knowledge:${contributorId}:${node.id}`, sourceId: `contributor:${contributorId}`, targetId: `knowledge:${node.id}`, relationshipType: 'contributed', explanation: '', confidence: 1, editable: false }); }
  const usable = connections.filter((connection) => nodeById.has(connection.sourceId) && nodeById.has(connection.targetId));
  const degree = new Map(); for (const connection of usable) for (const id of [connection.sourceId, connection.targetId]) degree.set(id, (degree.get(id) || 0) + 1);
  const selectedId = nodeById.has(requestedId) ? requestedId : [...degree.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || nodes[0]?.id || '';
  const focus = nodeById.get(selectedId) || null;
  const visible = usable.filter((connection) => connection.sourceId === selectedId || connection.targetId === selectedId).map((connection) => { const outgoing = connection.sourceId === selectedId; return { ...connection, direction: outgoing ? 'outgoing' : 'incoming', neighbour: nodeById.get(outgoing ? connection.targetId : connection.sourceId) }; }).sort((a, b) => String(a.neighbour?.title).localeCompare(String(b.neighbour?.title)));
  const kindOrder = { root: 0, host: 1, episode: 2, contributor: 3, concept: 4, claim: 5, example: 6, question: 7, snack: 8 };
  return { focus, explicitFocus: Boolean(requestedId && nodeById.has(requestedId)), connections: visible, allConnections: usable, nodes: [...nodes].sort((a, b) => (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9) || String(a.title).localeCompare(String(b.title))), totals: { nodes: nodes.length, knowledge: knowledgeNodes.length, connections: usable.length } };
}
