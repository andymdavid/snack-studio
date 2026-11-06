// Keep navigation gateways independent of the content budget. Focus enriches the
// map rather than isolating a cluster and removing routes to other episodes.
export function selectGraphView(model, options = {}) {
  const requested = Math.max(1, options.limit || model.viewLimit || 320);
  const focus = Object.hasOwn(options, 'focusId') ? options.focusId : model.focus?.id;
  const byId = new Map(model.nodes.map(node => [node.id, node]));
  const picked = new Set();
  const add = id => { if (byId.has(id)) picked.add(id); };
  for (const node of model.nodes) if (['root','episode','host','contributor','canonical'].includes(node.kind)) add(node.id);
  if (focus) {
    add(focus);
    const focused = byId.get(focus);
    // Complete episode content takes priority; high-degree people and concepts
    // retain their immediate connections even if that exceeds the sample budget.
    if (focused?.kind === 'episode') for (const node of model.nodes) if (node.episodeId === focused.episodeId) add(node.id);
    for (const edge of model.allConnections) if (edge.sourceId === focus || edge.targetId === focus) add(edge.sourceId === focus ? edge.targetId : edge.sourceId);
  }
  const limit = Math.max(requested, picked.size);
  const groups = new Map();
  for (const node of model.nodes) { if (picked.has(node.id)) continue; const group = groups.get(node.episodeId) || []; group.push(node); groups.set(node.episodeId, group); }
  for (const [episode, group] of groups) {
    const kinds = ['concept','claim','snack','example','question'];
    const buckets = kinds.map(kind => group.filter(node => node.kind === kind));
    buckets.push(group.filter(node => !kinds.includes(node.kind)));
    const interleaved = [];
    for (let index = 0; interleaved.length < group.length; index++) for (const bucket of buckets) if (bucket[index]) interleaved.push(bucket[index]);
    groups.set(episode, interleaved);
  }
  for (let offset = 0; picked.size < Math.min(limit, model.nodes.length); offset++) {
    let added = false;
    for (const group of groups.values()) if (group[offset] && picked.size < limit) { add(group[offset].id); added = true; }
    if (!added) break;
  }
  const nodes = model.nodes.filter(node => picked.has(node.id));
  return { nodes, allConnections: model.allConnections.filter(edge => picked.has(edge.sourceId) && picked.has(edge.targetId)), totalNodes: model.nodes.length, hiddenNodes: model.nodes.length - nodes.length };
}
