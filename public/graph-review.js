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
  const contributorSnackLinks = new Set(); const knowledgeById = new Map(knowledgeNodes.map((node) => [node.id, node]));
  for (const link of Array.isArray(knowledge.snackLinks) ? knowledge.snackLinks : []) {
    if (link.reviewState === 'rejected') continue;
    const node = knowledgeById.get(link.knowledgeNodeId);
    for (const speaker of new Set((node?.evidence || []).map((item) => normalize(item.speaker)).filter(Boolean))) {
      const contributorId = contributorBySpeaker.get(speaker); const key = `${contributorId}:${link.candidateId}`;
      if (!contributorId || contributorSnackLinks.has(key)) continue;
      contributorSnackLinks.add(key);
      connections.push({ id: `contributor-snack:${key}`, sourceId: `contributor:${contributorId}`, targetId: `snack:${link.candidateId}`, relationshipType: 'contributed-to', explanation: 'Transcript evidence from this contributor supports the published Snack.', confidence: link.confidence, editable: false });
    }
  }
  const usable = connections.filter((connection) => nodeById.has(connection.sourceId) && nodeById.has(connection.targetId));
  const degree = new Map(); for (const connection of usable) for (const id of [connection.sourceId, connection.targetId]) degree.set(id, (degree.get(id) || 0) + 1);
  const selectedId = nodeById.has(requestedId) ? requestedId : [...degree.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || nodes[0]?.id || '';
  const focus = nodeById.get(selectedId) || null;
  const visible = usable.filter((connection) => connection.sourceId === selectedId || connection.targetId === selectedId).map((connection) => { const outgoing = connection.sourceId === selectedId; return { ...connection, direction: outgoing ? 'outgoing' : 'incoming', neighbour: nodeById.get(outgoing ? connection.targetId : connection.sourceId) }; }).sort((a, b) => String(a.neighbour?.title).localeCompare(String(b.neighbour?.title)));
  const kindOrder = { root: 0, host: 1, episode: 2, contributor: 3, concept: 4, claim: 5, example: 6, question: 7, snack: 8 };
  return { focus, explicitFocus: Boolean(requestedId && nodeById.has(requestedId)), connections: visible, allConnections: usable, nodes: [...nodes].sort((a, b) => (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9) || String(a.title).localeCompare(String(b.title))), totals: { nodes: nodes.length, knowledge: knowledgeNodes.length, connections: usable.length } };
}

export function deriveGraphDashboard(payload = {}) {
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const knowledge = payload.knowledge && typeof payload.knowledge === 'object' ? payload.knowledge : {};
  const knowledgeNodes = Array.isArray(knowledge.nodes) ? knowledge.nodes : [];
  const topicIndex = payload.topicIndex && typeof payload.topicIndex === 'object' ? payload.topicIndex : {};
  const topics = Array.isArray(topicIndex.topics) ? topicIndex.topics : []; const passages = Array.isArray(topicIndex.passages) ? topicIndex.passages : []; const analyses = Array.isArray(topicIndex.analyses) ? topicIndex.analyses : [];
  const rootColours = {
    agents: '#d1ddd3', 'ai-coding': '#3292ff', 'ai-models-infrastructure': '#75c9c8', bitcoin: '#fe7141',
    'business-markets': '#f4bf58', 'knowledge-memory': '#ef8fb1', 'privacy-security': '#d89b72',
    'social-media': '#6b8fd6', 'software-systems': '#cdabfe',
  };
  const rootFallbackColours = ['#fe7445','#334891','#d1ddd3','#a89be8','#7ba2ad','#e07250','#cdabfe','#153250','#c8d5c2'];
  const colourFamily = (hex, count) => {
    const value = String(hex).replace('#', '');
    const [r, g, b] = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
    const max = Math.max(r, g, b); const min = Math.min(r, g, b); const delta = max - min; const midpoint = (max + min) / 2;
    let hue = 0;
    if (delta) { if (max === r) hue = ((g - b) / delta) % 6; else if (max === g) hue = (b - r) / delta + 2; else hue = (r - g) / delta + 4; }
    hue = Math.round((hue * 60 + 360) % 360);
    const saturation = Math.round(delta ? delta / (1 - Math.abs(2 * midpoint - 1)) * 100 : 0);
    const familySaturation = Math.max(28, saturation);
    return Array.from({ length: count }, (_, index) => {
      const lightness = count === 1 ? 58 : Math.round(34 + (48 * index / (count - 1)));
      return `hsl(${hue} ${familySaturation}% ${lightness}%)`;
    });
  };
  const rawTopicById = new Map(topics.map((topic) => [topic.id, topic]));
  const rootFor = (topicId) => { let topic = rawTopicById.get(topicId); const seen = new Set(); while (topic?.parentTopicId && rawTopicById.has(topic.parentTopicId) && !seen.has(topic.parentTopicId)) { seen.add(topic.id); topic = rawTopicById.get(topic.parentTopicId); } return topic?.id || topicId; };
  const rootTopics = topics.filter((topic) => !topic.parentTopicId).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const rootColourById = new Map(rootTopics.map((topic, index) => [topic.id, rootColours[topic.id] || rootFallbackColours[index % rootFallbackColours.length]]));
  const childColourById = new Map();
  for (const root of rootTopics) {
    const children = topics.filter((topic) => rootFor(topic.id) === root.id && topic.id !== root.id).sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id)));
    const tones = colourFamily(rootColourById.get(root.id), children.length);
    children.forEach((topic, index) => childColourById.set(topic.id, tones[index]));
  }
  const topicById = new Map(topics.map((topic) => [topic.id, { ...topic, colour: childColourById.get(topic.id) || rootColourById.get(rootFor(topic.id)) || '#72817a' }]));
  const classifiedWords = analyses.reduce((sum, analysis) => sum + Number(analysis.classifiedWordCount || 0), 0); const totalWords = analyses.reduce((sum, analysis) => sum + Number(analysis.totalWordCount || 0), 0);
  const rootStats = new Map(); const subtopicStats = new Map();
  for (const passage of passages) {
    const primaryTopic = topicById.get(passage.primaryTopicId); const rootId = rootFor(passage.primaryTopicId); const root = topicById.get(rootId) || { id: rootId, name: rootId, description: '', colour: '#72817a' };
    const item = rootStats.get(rootId) || { id: rootId, name: root.name, description: root.description || '', colour: root.colour, words: 0, passages: new Set(), episodes: new Set() };
    item.words += Number(passage.wordCount || 0); item.passages.add(passage.id); item.episodes.add(passage.episodeId); rootStats.set(rootId, item);
    if (primaryTopic?.parentTopicId) {
      const rootChildren = subtopicStats.get(rootId) || new Map(); const child = rootChildren.get(primaryTopic.id) || { id: primaryTopic.id, rootId, name: primaryTopic.name, description: primaryTopic.description || '', colour: primaryTopic.colour, words: 0, passages: new Set(), episodes: new Map() };
      const words = Number(passage.wordCount || 0); child.words += words; child.passages.add(passage.id); child.episodes.set(passage.episodeId, (child.episodes.get(passage.episodeId) || 0) + words); rootChildren.set(primaryTopic.id, child); subtopicStats.set(rootId, rootChildren);
    }
    for (const secondaryId of passage.secondaryTopicIds || []) { const secondaryRootId = rootFor(secondaryId); const secondaryRoot = topicById.get(secondaryRootId); const secondary = rootStats.get(secondaryRootId) || { id: secondaryRootId, name: secondaryRoot?.name || secondaryRootId, description: secondaryRoot?.description || '', colour: secondaryRoot?.colour || '#72817a', words: 0, passages: new Set(), episodes: new Set() }; secondary.passages.add(passage.id); secondary.episodes.add(passage.episodeId); rootStats.set(secondaryRootId, secondary); }
  }
  const topicRows = [...rootStats.values()].map((item) => ({ id: item.id, name: item.name, description: item.description, colour: item.colour, words: item.words, count: item.passages.size, episodes: item.episodes.size, share: classifiedWords ? item.words / classifiedWords : 0 })).filter((topic) => topic.words > 0).sort((a, b) => b.words - a.words || a.name.localeCompare(b.name));
  const episodeById = new Map(candidates.map((candidate) => [candidate.episodeId, { id: candidate.episodeId, number: candidate.episodeNumber, title: candidate.episodeTitle }]));
  const subtopicsByRoot = Object.fromEntries([...subtopicStats.entries()].map(([rootId, children]) => {
    const rootWords = rootStats.get(rootId)?.words || 0;
    return [rootId, [...children.values()].map((item) => ({ id: item.id, rootId, name: item.name, description: item.description, colour: item.colour, words: item.words, count: item.passages.size, episodes: item.episodes.size, share: rootWords ? item.words / rootWords : 0, episodeRows: [...item.episodes.entries()].map(([episodeId, words]) => ({ ...(episodeById.get(episodeId) || { id: episodeId, number: null, title: 'Episode' }), words, share: item.words ? words / item.words : 0 })).sort((a, b) => b.words - a.words || Number(b.number || 0) - Number(a.number || 0)) })).sort((a, b) => b.words - a.words || a.name.localeCompare(b.name))];
  }));
  const episodeIds = new Set(candidates.map((candidate) => candidate.episodeId));
  const focus = deriveKnowledgeFocus(payload);
  return {
    totals: { episodes: episodeIds.size, snacks: candidates.length, knowledge: knowledgeNodes.length, connections: focus.allConnections.length, topicMatches: passages.length, classifiedWords, totalWords, coverage: totalWords ? classifiedWords / totalWords : 0 },
    topicRows, subtopicsByRoot,
  };
}
