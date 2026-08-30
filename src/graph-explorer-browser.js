import { MultiDirectedGraph } from 'graphology';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';
import Sigma from 'sigma';

const KIND_COLOURS = { root: '#343b37', host: '#4f78a8', episode: '#72817a', contributor: '#a26f49', concept: '#4aa8a5', claim: '#d96b45', example: '#d49a32', question: '#9674cf', snack: '#d65f87' };
const MUTED_KIND_COLOURS = { root: '#9da49f', host: '#a9bbd0', episode: '#b3bbb7', contributor: '#cbb7a8', concept: '#a9cecc', claim: '#d8b2a5', example: '#d8c49d', question: '#c5b8d9', snack: '#d8b2bf' };
const ACTIVE_COLOUR = '#fe7141';
let active = null;

const nodeSize = (node) => node.kind === 'root' ? 15 : node.kind === 'episode' ? 12 : node.kind === 'host' ? 11 : node.kind === 'contributor' ? 10 : node.kind === 'snack' ? 7 : 9;

export function mountKnowledgeGraph(container, model, onSelect) {
  active?.kill(); active = null; container.replaceChildren();
  const graph = new MultiDirectedGraph(); const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const connectedIds = new Set(model.allConnections.flatMap((connection) => [connection.sourceId, connection.targetId]));
  const usefulNodes = model.totals.knowledge ? model.nodes.filter((node) => connectedIds.has(node.id)) : model.nodes;
  const nodes = usefulNodes.slice(0, 500); const visible = new Set(nodes.map((node) => node.id));
  const degree = new Map(); for (const connection of model.allConnections) for (const id of [connection.sourceId, connection.targetId]) degree.set(id, (degree.get(id) || 0) + 1);
  const episodeNodes = nodes.filter((node) => node.kind === 'episode');
  const episodeAnchors = new Map(episodeNodes.map((node, index) => { const angle = (Math.PI * 2 * index / Math.max(1, episodeNodes.length)) - Math.PI / 2; return [node.episodeId, { x: Math.cos(angle) * 540, y: Math.sin(angle) * 540 }]; }));
  const episodeOffsets = new Map();
  const simulationNodes = nodes.map((node, index) => {
    const anchor = episodeAnchors.get(node.episodeId) || { x: 0, y: 0 }; const localIndex = episodeOffsets.get(node.episodeId) || 0; episodeOffsets.set(node.episodeId, localIndex + 1);
    const angle = localIndex * Math.PI * (3 - Math.sqrt(5)); const radius = node.kind === 'root' ? 0 : ['host','contributor'].includes(node.kind) ? 175 + index * 11 : 34 * Math.sqrt(localIndex);
    return { id: node.id, kind: node.kind, episodeId: node.episodeId, x: anchor.x + Math.cos(angle) * radius, y: anchor.y + Math.sin(angle) * radius, size: nodeSize(node), fx: node.kind === 'root' ? 0 : undefined, fy: node.kind === 'root' ? 0 : undefined };
  });
  const simulationLinks = [];
  for (const node of nodes) { const connected = degree.has(node.id); const position = simulationNodes.find((item) => item.id === node.id); graph.addNode(node.id, { label: node.title, kind: node.kind, episodeId: node.episodeId, connected, x: position.x, y: position.y, size: connected ? nodeSize(node) : 4, color: connected ? KIND_COLOURS[node.kind] || '#9aa5a0' : MUTED_KIND_COLOURS[node.kind] || '#b8bfbb' }); }
  for (const connection of model.allConnections) if (visible.has(connection.sourceId) && visible.has(connection.targetId)) { graph.addEdgeWithKey(connection.id, connection.sourceId, connection.targetId, { label: connection.relationshipType, size: 1.2, color: '#38413d' }); simulationLinks.push({ source: connection.sourceId, target: connection.targetId, relationshipType: connection.relationshipType }); }
  if (!graph.order) return () => {};
  const simulation = forceSimulation(simulationNodes)
    .force('link', forceLink(simulationLinks).id((node) => node.id).distance((link) => ['contains','features'].includes(link.relationshipType) ? 205 : ['publishes','contributed-to'].includes(link.relationshipType) ? 145 : link.relationshipType === 'developed-into' ? 96 : 128).strength((link) => ['contains','features','publishes','contributed-to'].includes(link.relationshipType) ? 0.18 : 0.13))
    .force('charge', forceManyBody().strength((node) => node.kind === 'root' ? -520 : node.kind === 'episode' ? -410 : -295).distanceMin(28).distanceMax(820))
    .force('collide', forceCollide().radius((node) => node.size + 25).strength(1).iterations(4))
    .force('center', forceCenter(0, 0).strength(0.015))
    .force('x', forceX((node) => episodeAnchors.get(node.episodeId)?.x || 0).strength((node) => node.kind === 'episode' ? 0.34 : ['host','contributor'].includes(node.kind) ? 0.025 : node.kind === 'root' ? 1 : 0.11))
    .force('y', forceY((node) => episodeAnchors.get(node.episodeId)?.y || 0).strength((node) => node.kind === 'episode' ? 0.34 : ['host','contributor'].includes(node.kind) ? 0.025 : node.kind === 'root' ? 1 : 0.11))
    .alphaDecay(0.022).alphaMin(0.002).velocityDecay(0.35).stop();
  const simulationNodeById = new Map(simulationNodes.map((node) => [node.id, node]));
  simulation.tick(60);
  for (const node of simulationNodes) graph.mergeNodeAttributes(node.id, { x: node.x, y: node.y });
  const canvas = document.createElement('div'); canvas.className = 'sigmaCanvas'; container.appendChild(canvas);
  let hovered = null; let hoveredNeighbours = new Set(); let selectedId = model.explicitFocus && model.focus?.id && graph.hasNode(model.focus.id) ? model.focus.id : null; let selectedNeighbours = new Set(selectedId ? graph.neighbors(selectedId) : []);
  const renderer = new Sigma(graph, canvas, {
    allowInvalidContainer: true, labelRenderedSizeThreshold: 14, labelDensity: 0.03, labelGridCellSize: 150,
    zoomingRatio: 1.25, zoomDuration: 220,
    defaultNodeColor: '#9aa5a0', defaultEdgeColor: '#bac1bd', defaultEdgeType: 'line', renderEdgeLabels: false, hideEdgesOnMove: false,
    nodeReducer(node, data) { const focusId = hovered || selectedId; const focusNeighbours = hovered ? hoveredNeighbours : selectedNeighbours; const selected = node === selectedId; const underPointer = node === hovered; const related = !focusId || node === focusId || focusNeighbours.has(node); return { ...data, highlighted: selected, forceLabel: selected || underPointer || (Boolean(focusId) && related) || data.kind === 'root', color: selected ? ACTIVE_COLOUR : focusId && !related ? MUTED_KIND_COLOURS[data.kind] || '#d2d6d3' : data.color, size: selected ? data.size * 1.4 : underPointer ? data.size * 1.18 : data.size, zIndex: selected ? 3 : underPointer ? 2 : related && focusId ? 1 : 0 }; },
    edgeReducer(edge, data) { const focusId = hovered || selectedId; if (!focusId) return { ...data, color: '#bac1bd', size: 0.75 }; const [source, target] = graph.extremities(edge); const activeEdge = source === focusId || target === focusId; return { ...data, color: activeEdge ? hovered ? '#7b8982' : ACTIVE_COLOUR : '#e1e4e2', size: activeEdge ? hovered ? 2.1 : 2.6 : 0.35, zIndex: activeEdge ? 1 : 0 }; },
  });
  let frame = null;
  const animateLayout = () => {
    simulation.tick();
    for (const node of simulationNodes) graph.mergeNodeAttributes(node.id, { x: node.x, y: node.y });
    renderer.refresh();
    if (simulation.alpha() > simulation.alphaMin()) frame = requestAnimationFrame(animateLayout);
    else frame = null;
  };
  const reheatLayout = (alpha) => {
    simulation.alpha(Math.max(simulation.alpha(), alpha));
    if (!frame) frame = requestAnimationFrame(animateLayout);
  };
  reheatLayout(simulation.alpha());
  renderer.on('enterNode', ({ node }) => { hovered = node; hoveredNeighbours = new Set(graph.neighbors(node)); renderer.getContainer().style.cursor = 'pointer'; renderer.refresh(); });
  renderer.on('leaveNode', () => { hovered = null; hoveredNeighbours = new Set(); renderer.getContainer().style.cursor = 'grab'; renderer.refresh(); });
  let draggedId = null; let dragged = false; let suppressClick = false;
  const releaseDraggedNode = () => {
    if (!draggedId) return;
    const node = simulationNodeById.get(draggedId);
    if (node) { node.fx = node.kind === 'root' ? 0 : null; node.fy = node.kind === 'root' ? 0 : null; }
    draggedId = null; renderer.getCamera().enable(); renderer.getContainer().style.cursor = 'grab'; reheatLayout(0.48);
  };
  renderer.on('downNode', ({ node, event }) => {
    event.preventSigmaDefault(); draggedId = node; dragged = false;
    const simulationNode = simulationNodeById.get(node);
    if (simulationNode) { simulationNode.fx = simulationNode.x; simulationNode.fy = simulationNode.y; }
    renderer.getCamera().disable(); renderer.getContainer().style.cursor = 'grabbing'; reheatLayout(0.3);
  });
  renderer.on('moveBody', ({ event }) => {
    if (!draggedId) return;
    const simulationNode = simulationNodeById.get(draggedId); if (!simulationNode) return;
    const position = renderer.viewportToGraph({ x: event.x, y: event.y });
    simulationNode.fx = position.x; simulationNode.fy = position.y; simulationNode.x = position.x; simulationNode.y = position.y;
    dragged = true; suppressClick = true; reheatLayout(0.34);
  });
  renderer.on('upNode', releaseDraggedNode);
  renderer.on('upStage', releaseDraggedNode);
  const closeSpotlight = () => container.querySelector('.graphSpotlight')?.remove();
  renderer.on('clickNode', ({ node }) => {
    if (suppressClick || dragged) { suppressClick = false; dragged = false; return; }
    selectedId = node; selectedNeighbours = new Set(graph.neighbors(node)); renderer.refresh(); closeSpotlight();
    const item = nodeById.get(node); const display = renderer.getNodeDisplayData(node); const card = document.createElement('article'); card.className = 'graphSpotlight';
    const kind = document.createElement('span'); kind.className = 'eyebrow'; kind.textContent = item.kind;
    const title = document.createElement('h3'); title.textContent = item.title;
    const meta = document.createElement('span'); meta.className = 'metadata'; meta.textContent = `${graph.degree(node)} connection${graph.degree(node) === 1 ? '' : 's'}${item.episodeNumber ? ` · Episode ${item.episodeNumber}` : ''}`;
    const summary = document.createElement('p'); summary.textContent = item.summary || 'Explore this node’s connections in the knowledge graph.';
    const open = document.createElement('button'); open.type = 'button'; open.className = 'btn btnPrimary'; open.textContent = item.kind === 'snack' ? 'Open Snack' : ['host','contributor'].includes(item.kind) ? 'Open contributor' : 'Explore node'; open.addEventListener('click', () => onSelect(node, item));
    card.append(kind, title, meta, summary, open); container.appendChild(card);
    const width = container.clientWidth, height = container.clientHeight; card.style.left = `${Math.max(220, Math.min(width - 220, display?.x || width / 2))}px`; card.style.top = `${Math.max(150, Math.min(height - 170, display?.y || height / 2))}px`;
  });
  renderer.on('clickStage', () => { selectedId = null; selectedNeighbours = new Set(); closeSpotlight(); renderer.refresh(); });
  const controls = document.createElement('div'); controls.className = 'sigmaControls';
  for (const [label, title, action] of [['+', 'Zoom in', () => renderer.getCamera().animatedZoom({ duration: 180 })], ['−', 'Zoom out', () => renderer.getCamera().animatedUnzoom({ duration: 180 })], ['⌂', 'Fit graph', () => renderer.getCamera().animatedReset({ duration: 260 })]]) { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.title = title; button.setAttribute('aria-label', title); button.addEventListener('click', action); controls.appendChild(button); }
  container.appendChild(controls);
  renderer.getCamera().animatedReset({ duration: 420 });
  active = { kill() { if (frame) cancelAnimationFrame(frame); simulation.stop(); renderer.kill(); container.replaceChildren(); } };
  return () => { if (active) { active.kill(); active = null; } };
}
