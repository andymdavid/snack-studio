import { MultiDirectedGraph } from 'graphology';
import circular from 'graphology-layout/circular';
import FA2Layout from 'graphology-layout-forceatlas2/worker';
import Sigma from 'sigma';

const KIND_COLOURS = { concept: '#75c9c8', claim: '#fe7141', example: '#f4bf58', question: '#cdabfe', snack: '#ef8fb1' };
let active = null;

export function mountKnowledgeGraph(container, model, onSelect) {
  active?.kill(); active = null; container.replaceChildren();
  const graph = new MultiDirectedGraph(); const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const connected = new Set(model.allConnections.flatMap((connection) => [connection.sourceId, connection.targetId]));
  const nodes = model.nodes.filter((node) => connected.has(node.id)).slice(0, 500); const visible = new Set(nodes.map((node) => node.id));
  for (const node of nodes) graph.addNode(node.id, { label: node.title, kind: node.kind, episodeId: node.episodeId, x: 0, y: 0, size: node.kind === 'snack' ? 6 : 9, color: KIND_COLOURS[node.kind] || '#9aa5a0' });
  for (const connection of model.allConnections) if (visible.has(connection.sourceId) && visible.has(connection.targetId)) graph.addEdgeWithKey(connection.id, connection.sourceId, connection.targetId, { label: connection.relationshipType, size: 1.2, color: '#38413d' });
  if (!graph.order) return () => {};
  circular.assign(graph, { scale: Math.max(10, graph.order / 3) });
  const canvas = document.createElement('div'); canvas.className = 'sigmaCanvas'; container.appendChild(canvas);
  let hovered = null; const focusId = model.focus?.id && graph.hasNode(model.focus.id) ? model.focus.id : null; const neighbours = new Set(focusId ? graph.neighbors(focusId) : []);
  const renderer = new Sigma(graph, canvas, {
    allowInvalidContainer: true, labelRenderedSizeThreshold: 7, labelDensity: 0.08, labelGridCellSize: 120,
    defaultNodeColor: '#9aa5a0', defaultEdgeColor: '#38413d', renderEdgeLabels: false, hideEdgesOnMove: true,
    nodeReducer(node, data) { const selected = node === focusId || node === hovered; const adjacent = !focusId || neighbours.has(node); return { ...data, highlighted: selected, forceLabel: selected, color: focusId && !selected && !adjacent ? '#303633' : data.color, size: selected ? data.size * 1.45 : data.size, zIndex: selected ? 2 : 0 }; },
    edgeReducer(edge, data) { if (!focusId) return data; const [source, target] = graph.extremities(edge); const activeEdge = source === focusId || target === focusId; return { ...data, color: activeEdge ? '#fe7141' : '#2d332f', size: activeEdge ? 2.4 : 0.7, zIndex: activeEdge ? 1 : 0 }; },
  });
  renderer.on('enterNode', ({ node }) => { hovered = node; renderer.getContainer().style.cursor = 'pointer'; renderer.refresh(); });
  renderer.on('leaveNode', () => { hovered = null; renderer.getContainer().style.cursor = 'grab'; renderer.refresh(); });
  renderer.on('clickNode', ({ node }) => onSelect(node, nodeById.get(node)));
  const controls = document.createElement('div'); controls.className = 'sigmaControls';
  for (const [label, title, action] of [['+', 'Zoom in', () => renderer.getCamera().animatedZoom({ duration: 180 })], ['−', 'Zoom out', () => renderer.getCamera().animatedUnzoom({ duration: 180 })], ['⌂', 'Fit graph', () => renderer.getCamera().animatedReset({ duration: 260 })]]) { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.title = title; button.setAttribute('aria-label', title); button.addEventListener('click', action); controls.appendChild(button); }
  container.appendChild(controls);
  const layout = graph.order > 1 ? new FA2Layout(graph, { settings: { barnesHutOptimize: graph.order > 80, gravity: 1.2, scalingRatio: 6, slowDown: 4, linLogMode: true, adjustSizes: true } }) : null;
  layout?.start();
  const settleTimer = setTimeout(() => { layout?.stop(); renderer.getCamera().animatedReset({ duration: 420 }); }, Math.min(3500, 900 + graph.order * 18));
  active = { kill() { clearTimeout(settleTimer); layout?.kill(); renderer.kill(); container.replaceChildren(); } };
  return () => { if (active) { active.kill(); active = null; } };
}
