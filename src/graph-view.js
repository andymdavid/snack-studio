export function selectGraphView(model, options = {}) {
  const limit = Math.max(1, options.limit || 160);
  const focus = options.focusId || model.focus?.id;
  const byId = new Map(model.nodes.map((node) => [node.id, node]));
  const picked = new Set();
  const add = (id) => { if (byId.has(id) && picked.size < limit) picked.add(id); };
  if (focus) {
    add(focus);
    for (const edge of model.allConnections) if (edge.sourceId === focus || edge.targetId === focus) add(edge.sourceId === focus ? edge.targetId : edge.sourceId);
  } else {
    for (const node of model.nodes) if (['root','episode','host','contributor','canonical'].includes(node.kind)) add(node.id);
    const groups = new Map();
    for (const node of model.nodes) { const group = groups.get(node.episodeId) || []; group.push(node); groups.set(node.episodeId, group); }
    for (let offset = 0; picked.size < Math.min(limit, model.nodes.length); offset++) {
      let added = false;
      for (const group of groups.values()) if (group[offset]) { add(group[offset].id); added = true; }
      if (!added) break;
    }
  }
  const nodes = model.nodes.filter((node) => picked.has(node.id));
  return { nodes, allConnections: model.allConnections.filter((edge) => picked.has(edge.sourceId) && picked.has(edge.targetId)), totalNodes: model.nodes.length, hiddenNodes: model.nodes.length - nodes.length };
}
