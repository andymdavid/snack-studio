import { MultiDirectedGraph } from 'graphology';
import circular from 'graphology-layout/circular';
import FA2Layout from 'graphology-layout-forceatlas2/worker';
import noverlap from 'graphology-layout-noverlap';
import Sigma from 'sigma';

const KIND_COLOURS = { concept: '#4aa8a5', claim: '#d96b45', example: '#d49a32', question: '#9674cf', snack: '#d65f87' };
const MUTED_KIND_COLOURS = { concept: '#a9cecc', claim: '#d8b2a5', example: '#d8c49d', question: '#c5b8d9', snack: '#d8b2bf' };
const ACTIVE_COLOUR = '#fe7141';
let active = null;

export function mountKnowledgeGraph(container, model, onSelect) {
  active?.kill(); active = null; container.replaceChildren();
  const graph = new MultiDirectedGraph(); const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const connectedIds = new Set(model.allConnections.flatMap((connection) => [connection.sourceId, connection.targetId]));
  const usefulNodes = model.totals.knowledge ? model.nodes.filter((node) => connectedIds.has(node.id)) : model.nodes;
  const nodes = usefulNodes.slice(0, 500); const visible = new Set(nodes.map((node) => node.id));
  const degree = new Map(); for (const connection of model.allConnections) for (const id of [connection.sourceId, connection.targetId]) degree.set(id, (degree.get(id) || 0) + 1);
  for (const node of nodes) { const connected = degree.has(node.id); graph.addNode(node.id, { label: node.title, kind: node.kind, episodeId: node.episodeId, connected, x: 0, y: 0, size: connected ? node.kind === 'snack' ? 7 : 9 : 4, color: connected ? KIND_COLOURS[node.kind] || '#9aa5a0' : MUTED_KIND_COLOURS[node.kind] || '#b8bfbb' }); }
  for (const connection of model.allConnections) if (visible.has(connection.sourceId) && visible.has(connection.targetId)) graph.addEdgeWithKey(connection.id, connection.sourceId, connection.targetId, { label: connection.relationshipType, size: 1.2, color: '#38413d' });
  if (!graph.order) return () => {};
  circular.assign(graph, { scale: Math.max(10, graph.order / 3) });
  const canvas = document.createElement('div'); canvas.className = 'sigmaCanvas'; container.appendChild(canvas);
  let hovered = null; const focusId = model.explicitFocus && model.focus?.id && graph.hasNode(model.focus.id) ? model.focus.id : null; const neighbours = new Set(focusId ? graph.neighbors(focusId) : []);
  const renderer = new Sigma(graph, canvas, {
    allowInvalidContainer: true, labelRenderedSizeThreshold: 14, labelDensity: 0.03, labelGridCellSize: 150,
    defaultNodeColor: '#9aa5a0', defaultEdgeColor: '#7f8984', defaultEdgeType: 'line', renderEdgeLabels: false, hideEdgesOnMove: false,
    nodeReducer(node, data) { const selected = node === focusId; const underPointer = node === hovered; const adjacent = !focusId || neighbours.has(node); return { ...data, highlighted: selected, forceLabel: selected || underPointer, color: selected ? ACTIVE_COLOUR : focusId && !adjacent ? MUTED_KIND_COLOURS[data.kind] || '#b8bfbb' : data.color, size: selected ? data.size * 1.4 : underPointer ? data.size * 1.12 : data.size, zIndex: selected ? 2 : underPointer ? 1 : 0 }; },
    edgeReducer(edge, data) { if (!focusId) return { ...data, color: '#7f8984', size: 1.8 }; const [source, target] = graph.extremities(edge); const activeEdge = source === focusId || target === focusId; return { ...data, color: activeEdge ? ACTIVE_COLOUR : '#9ca5a0', size: activeEdge ? 3 : 1.4, zIndex: activeEdge ? 1 : 0 }; },
  });
  renderer.on('enterNode', ({ node }) => { hovered = node; renderer.getContainer().style.cursor = 'pointer'; renderer.refresh(); });
  renderer.on('leaveNode', () => { hovered = null; renderer.getContainer().style.cursor = 'grab'; renderer.refresh(); });
  renderer.on('clickNode', ({ node }) => onSelect(node, nodeById.get(node)));
  const controls = document.createElement('div'); controls.className = 'sigmaControls';
  for (const [label, title, action] of [['+', 'Zoom in', () => renderer.getCamera().animatedZoom({ duration: 180 })], ['−', 'Zoom out', () => renderer.getCamera().animatedUnzoom({ duration: 180 })], ['⌂', 'Fit graph', () => renderer.getCamera().animatedReset({ duration: 260 })]]) { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.title = title; button.setAttribute('aria-label', title); button.addEventListener('click', action); controls.appendChild(button); }
  container.appendChild(controls);
  const layout = graph.order > 1 ? new FA2Layout(graph, { settings: { barnesHutOptimize: graph.order > 80, gravity: 1.2, scalingRatio: 6, slowDown: 4, linLogMode: true, adjustSizes: true } }) : null;
  layout?.start();
  const settleTimer = setTimeout(() => { layout?.stop(); noverlap.assign(graph, { maxIterations: 120, settings: { margin: 4, ratio: 1.6, expansion: 1.08, speed: 2 } }); renderer.refresh(); renderer.getCamera().animatedReset({ duration: 420 }); }, Math.min(3500, 900 + graph.order * 18));
  active = { kill() { clearTimeout(settleTimer); layout?.kill(); renderer.kill(); container.replaceChildren(); } };
  return () => { if (active) { active.kill(); active = null; } };
}
