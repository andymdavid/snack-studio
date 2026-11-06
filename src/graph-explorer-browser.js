import { placeGraphLabels } from './graph-labels.js';
import { selectGraphView } from './graph-view.js';
import { MultiDirectedGraph } from 'graphology';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';
import Sigma from 'sigma';

const KIND_COLOURS = { root: '#343b37', host: '#4f78a8', episode: '#72817a', contributor: '#a26f49', concept: '#4aa8a5', claim: '#d96b45', example: '#d49a32', question: '#9674cf', canonical: '#1e7069', snack: '#d65f87' };
const MUTED_KIND_COLOURS = { root: '#9da49f', host: '#a9bbd0', episode: '#b3bbb7', contributor: '#cbb7a8', concept: '#a9cecc', claim: '#d8b2a5', example: '#d8c49d', question: '#c5b8d9', canonical: '#a9cecc', snack: '#d8b2bf' };
const ACTIVE_COLOUR = '#fe7141';
let active = null;
const retainedPositions = new Map();

const nodeSize = (node) => node.kind === 'root' ? 8 : node.kind === 'episode' ? 10 : node.kind === 'host' ? 7 : node.kind === 'contributor' ? 7 : node.kind === 'snack' ? 5 : 6;

export function mountKnowledgeGraph(container, model, onSelect) {
  active?.kill(); active = null; container.replaceChildren();
  const graph = new MultiDirectedGraph(); const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const view = selectGraphView(model, { focusId: model.explicitFocus ? model.focus?.id : null, limit: model.viewLimit || 160 });
  const nodes = view.nodes; const visible = new Set(nodes.map((node) => node.id));
  const degree = new Map(); for (const connection of model.allConnections) for (const id of [connection.sourceId, connection.targetId]) degree.set(id, (degree.get(id) || 0) + 1);
  const focusedEpisode = model.focus?.kind === 'episode' && model.explicitFocus;
  const episodeNodes = nodes.filter((node) => node.kind === 'episode');
  const episodeAnchors = new Map(episodeNodes.map((node, index) => { const angle = (Math.PI * 2 * index / Math.max(1, episodeNodes.length)) - Math.PI / 2; return [node.episodeId, focusedEpisode ? {x:0,y:0} : { x: Math.cos(angle) * 680, y: Math.sin(angle) * 680 }]; }));
  const episodeOffsets = new Map();
  const simulationNodes = nodes.map((node, index) => {
    const anchor = episodeAnchors.get(node.episodeId) || { x: 0, y: 0 }; const localIndex = episodeOffsets.get(node.episodeId) || 0; episodeOffsets.set(node.episodeId, localIndex + 1);
    const angle = localIndex * Math.PI * (3 - Math.sqrt(5)); const radius = node.kind === 'root' ? 0 : ['host','contributor'].includes(node.kind) ? 210 + index * 12 : (focusedEpisode ? 75 : 42) * Math.sqrt(localIndex);
    const previous = retainedPositions.get(node.id);
    return { id: node.id, kind: node.kind, episodeId: node.episodeId, x: previous?.x ?? anchor.x + Math.cos(angle) * radius, y: previous?.y ?? anchor.y + Math.sin(angle) * radius, size: nodeSize(node), fx: (focusedEpisode ? node.id === model.focus.id : node.kind === 'root') ? 0 : undefined, fy: (focusedEpisode ? node.id === model.focus.id : node.kind === 'root') ? 0 : undefined };
  });
  const simulationLinks = [];
  for (const node of nodes) { const connected = degree.has(node.id); const position = simulationNodes.find((item) => item.id === node.id); graph.addNode(node.id, { label: node.title, kind: node.kind, episodeId: node.episodeId, connected, x: position.x, y: position.y, size: connected ? nodeSize(node) : 4, color: connected ? KIND_COLOURS[node.kind] || '#9aa5a0' : MUTED_KIND_COLOURS[node.kind] || '#b8bfbb' }); }
  for (const connection of model.allConnections) if (visible.has(connection.sourceId) && visible.has(connection.targetId)) { graph.addEdgeWithKey(connection.id, connection.sourceId, connection.targetId, { label: connection.relationshipType, size: 1.2, color: '#38413d' }); simulationLinks.push({ source: connection.sourceId, target: connection.targetId, relationshipType: connection.relationshipType }); }
  if (!graph.order) return () => {};
  const simulation = forceSimulation(simulationNodes)
    .force('link', forceLink(simulationLinks).id((node) => node.id).distance((link) => ['contains','features','hosted-by'].includes(link.relationshipType) ? 250 : ['publishes','contributed-to','hosted'].includes(link.relationshipType) ? 175 : link.relationshipType === 'developed-into' ? 118 : 150).strength((link) => ['contains','features','hosted-by'].includes(link.relationshipType) ? 0.035 : ['publishes','contributed-to','hosted'].includes(link.relationshipType) ? 0.05 : 0.04))
    .force('charge', forceManyBody().strength((node) => focusedEpisode ? -850 : node.kind === 'root' ? -520 : node.kind === 'episode' ? -410 : -295).distanceMin(28).distanceMax(820))
    .force('collide', forceCollide().radius((node) => node.size + (focusedEpisode ? 40 : 25)).strength(1).iterations(4))
    .force('center', forceCenter(0, 0).strength(0.015))
    .force('x', forceX((node) => episodeAnchors.get(node.episodeId)?.x || 0).strength((node) => node.kind === 'episode' ? 0.12 : ['host','contributor'].includes(node.kind) ? 0.005 : node.kind === 'root' ? (focusedEpisode ? 0.005 : 0.4) : (focusedEpisode ? 0.012 : 0.055)))
    .force('y', forceY((node) => episodeAnchors.get(node.episodeId)?.y || 0).strength((node) => node.kind === 'episode' ? 0.12 : ['host','contributor'].includes(node.kind) ? 0.005 : node.kind === 'root' ? (focusedEpisode ? 0.005 : 0.4) : (focusedEpisode ? 0.012 : 0.055)))
    .alphaDecay(0.028).alphaMin(0.002).velocityDecay(0.58).stop();
  const simulationNodeById = new Map(simulationNodes.map((node) => [node.id, node]));
  const retained = nodes.every(node => retainedPositions.has(node.id));
  simulation.tick(retained ? 0 : focusedEpisode ? 180 : window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 100 : 40);
  if (retained) simulation.alpha(0.04);
  if (focusedEpisode && !retained) for(const node of simulationNodes) node.x *= 1.6;
  for (const node of simulationNodes) graph.mergeNodeAttributes(node.id, { x: node.x, y: node.y });
  const canvas = document.createElement('div'); canvas.className = 'sigmaCanvas'; container.appendChild(canvas);
  let hovered = null; let hoveredNeighbours = new Set(); let selectedId = model.selectedNodeId && graph.hasNode(model.selectedNodeId) ? model.selectedNodeId : model.explicitFocus && model.focus?.id && graph.hasNode(model.focus.id) ? model.focus.id : null; let selectedNeighbours = new Set(selectedId ? graph.neighbors(selectedId) : []);
  const renderer = new Sigma(graph, canvas, {
    allowInvalidContainer: true, renderLabels:false, stagePadding:container.clientWidth<600?24:64,
    defaultDrawNodeHover(context,data) { context.beginPath();context.arc(data.x,data.y,data.size+4,0,Math.PI*2);context.fillStyle='#fe714133';context.fill(); },
    zoomingRatio: 1.25, zoomDuration: 220,
    defaultNodeColor: '#9aa5a0', defaultEdgeColor: '#d0d5d2', defaultEdgeType: 'line', renderEdgeLabels: false, hideEdgesOnMove: false,
    nodeReducer(node, data) { const focusId = hovered || selectedId; const focusNeighbours = hovered ? hoveredNeighbours : selectedNeighbours; const selected = node === selectedId; const underPointer = node === hovered; const related = !focusId || node === focusId || focusNeighbours.has(node); return { ...data, highlighted: selected, forceLabel: false, color: selected ? ACTIVE_COLOUR : focusId && !related ? MUTED_KIND_COLOURS[data.kind] || '#d2d6d3' : data.color, size: selected ? data.size * 1.4 : underPointer ? data.size * 1.18 : data.size, zIndex: selected ? 3 : underPointer ? 2 : related && focusId ? 1 : 0 }; },
    edgeReducer(edge, data) { const focusId = hovered || selectedId; const [source, target] = graph.extremities(edge); const structural = [source,target].some(id=>['root','episode','host','contributor'].includes(graph.getNodeAttribute(id,'kind'))); if (!focusId || focusedEpisode && focusId === model.focus.id) return { ...data, color: structural ? '#dce1dd' : '#b5c0b8', size: structural ? 0.35 : 0.7 }; const activeEdge = source === focusId || target === focusId; return { ...data, color: activeEdge ? hovered ? '#87958e' : ACTIVE_COLOUR : '#eceeec', size: activeEdge ? hovered ? 1.2 : 1.6 : 0.25, zIndex: activeEdge ? 1 : 0 }; },
  });
  const ns='http://www.w3.org/2000/svg';
  const labelLayer=document.createElementNS(ns,'svg');labelLayer.classList.add('graphTextLayer');labelLayer.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:hidden';labelLayer.setAttribute('aria-hidden','true');container.appendChild(labelLayer);
  const tooltip=document.createElement('div');tooltip.className='graphHoverTitle';tooltip.style.cssText='position:absolute;z-index:8;box-sizing:border-box;max-width:min(280px,calc(100% - 16px));padding:.65rem .8rem;background:#fff;border:1px solid #bbc5be;border-radius:4px;box-shadow:0 5px 20px #0001;font:12px/1.5 Arial,sans-serif;color:#202824;pointer-events:none';tooltip.hidden=true;container.appendChild(tooltip);
  const measure=document.createElement('canvas').getContext('2d');measure.font='11px Arial';
  function renderText() {
    const width=container.clientWidth,height=container.clientHeight;
    labelLayer.setAttribute('viewBox',`0 0 ${width} ${height}`);
    const screen=nodes.map(node=>{const display=renderer.getNodeDisplayData(node.id);const position=renderer.framedGraphToViewport(display);return {...node,...position,size:renderer.scaleSize(display.size)};}).filter(node=>node.x>=0&&node.y>=0&&node.x<=width&&node.y<=height);
    const labels=placeGraphLabels(screen,{width,height,zoom:renderer.getCamera().ratio,selectedId,hoveredId:hovered,measureText:text=>measure.measureText(text).width});
    labelLayer.replaceChildren();
    for(const label of labels){const group=document.createElementNS(ns,'g');group.dataset.nodeId=label.id;group.dataset.nodeX=String(label.nodeX);group.dataset.nodeY=String(label.nodeY);if(label.active&&Math.hypot(label.x+label.width/2-label.nodeX,label.y+label.height/2-label.nodeY)>80){const line=document.createElementNS(ns,'line');for(const [key,value] of Object.entries({x1:label.nodeX,y1:label.nodeY,x2:label.x+label.width/2,y2:label.y+label.height/2,stroke:'#c98768','stroke-opacity':.5,'stroke-width':.7}))line.setAttribute(key,String(value));group.append(line);}const rect=document.createElementNS(ns,'rect');for(const [key,value] of Object.entries({x:label.x,y:label.y,width:label.width,height:label.height,rx:3,fill:label.active?'#fff7f0':'#faf9f9','fill-opacity':.92}))rect.setAttribute(key,String(value));const text=document.createElementNS(ns,'text');text.setAttribute('x',String(label.x+5));text.setAttribute('y',String(label.y+12));text.setAttribute('font-family','Arial,sans-serif');text.setAttribute('font-size','11');text.setAttribute('fill',label.active?'#a33d1a':'#4e5d53');text.textContent=label.text;group.append(rect,text);labelLayer.append(group);}
    if(hovered){const node=screen.find(node=>node.id===hovered);if(node){tooltip.textContent=nodeById.get(hovered).title;tooltip.hidden=false;tooltip.style.left=`${Math.max(8,Math.min(width-296,node.x+16))}px`;tooltip.style.top=`${Math.max(40,Math.min(height-tooltip.offsetHeight-12,node.y+18))}px`;}}else tooltip.hidden=true;
  }
  renderer.on('afterRender',renderText);
  const resize=()=>{renderer.resize();renderer.refresh();};
  container.addEventListener('graph-layout-change',resize);
  let frame = null; let paused = Boolean(model.freezeLayout);
  const animateLayout = () => {
    simulation.tick();
    for (const node of simulationNodes) graph.mergeNodeAttributes(node.id, { x: node.x, y: node.y });
    renderer.refresh();
    if (simulation.alpha() > simulation.alphaMin()) frame = requestAnimationFrame(animateLayout);
    else frame = null;
  };
  const reheatLayout = (alpha) => {
    simulation.alpha(Math.max(simulation.alpha(), alpha));
    if (!paused && !frame && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) frame = requestAnimationFrame(animateLayout);
  };
  if (!focusedEpisode && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) reheatLayout(simulation.alpha());
  renderer.on('enterNode', ({ node }) => { hovered = node; hoveredNeighbours = new Set(graph.neighbors(node)); renderer.getContainer().style.cursor = 'pointer'; renderer.refresh(); });
  renderer.on('leaveNode', () => { hovered = null; hoveredNeighbours = new Set(); renderer.getContainer().style.cursor = 'grab'; renderer.refresh(); });
  let draggedId = null; let dragged = false; let suppressClick = false;
  const releaseDraggedNode = () => {
    if (!draggedId) return;
    const node = simulationNodeById.get(draggedId);
    if (node) { node.fx = node.kind === 'root' ? 0 : null; node.fy = node.kind === 'root' ? 0 : null; }
    draggedId = null; renderer.getCamera().enable(); renderer.getContainer().style.cursor = 'grab'; reheatLayout(0.42);
  };
  renderer.on('downNode', ({ node, event }) => {
    event.preventSigmaDefault(); draggedId = node; dragged = false;
    const simulationNode = simulationNodeById.get(node);
    if (simulationNode) { simulationNode.fx = simulationNode.x; simulationNode.fy = simulationNode.y; }
    renderer.getCamera().disable(); renderer.getContainer().style.cursor = 'grabbing'; reheatLayout(0.08);
  });
  renderer.on('moveBody', ({ event }) => {
    if (!draggedId) return;
    const simulationNode = simulationNodeById.get(draggedId); if (!simulationNode) return;
    const position = renderer.viewportToGraph({ x: event.x, y: event.y });
    simulationNode.fx = position.x; simulationNode.fy = position.y; simulationNode.x = position.x; simulationNode.y = position.y;
    dragged = true; suppressClick = true; reheatLayout(0.11);
  });
  renderer.on('upNode', releaseDraggedNode);
  renderer.on('upStage', releaseDraggedNode);
  const closeSpotlight = () => container.querySelector('.graphSpotlight')?.remove();
  renderer.on('clickNode', ({ node }) => {
    if (suppressClick || dragged) { suppressClick = false; dragged = false; return; }
    if (model.selectImmediately) { onSelect(node, nodeById.get(node)); return; }
    selectedId = node; selectedNeighbours = new Set(graph.neighbors(node)); renderer.refresh(); closeSpotlight();
    const item = nodeById.get(node); const display = renderer.getNodeDisplayData(node); const card = document.createElement('article'); card.className = 'graphSpotlight';
    const kind = document.createElement('span'); kind.className = 'eyebrow'; kind.textContent = item.kind;
    const title = document.createElement('h3'); title.textContent = item.title;
    const meta = document.createElement('span'); meta.className = 'metadata'; meta.textContent = `${graph.degree(node)} connection${graph.degree(node) === 1 ? '' : 's'}${item.episodeNumber ? ` · Episode ${item.episodeNumber}` : ''}`;
    const summary = document.createElement('p'); summary.textContent = item.summary || 'Explore this node’s connections in the knowledge graph.';
    const open = document.createElement('button'); open.type = 'button'; open.className = 'btn btnPrimary'; open.textContent = item.kind === 'snack' ? 'Open Snack' : ['host','contributor'].includes(item.kind) ? 'Open contributor' : 'Explore node'; open.addEventListener('click', () => onSelect(node, item));
    card.append(kind, title, meta, summary, open); container.appendChild(card);
    const width = container.clientWidth, height = container.clientHeight; card.style.left = `${Math.max(220, Math.min(width - 220, renderer.framedGraphToViewport(display || {x:0,y:0}).x || width / 2))}px`; card.style.top = `${Math.max(150, Math.min(height - 170, renderer.framedGraphToViewport(display || {x:0,y:0}).y || height / 2))}px`;
  });
  renderer.on('clickStage', () => { selectedId = null; selectedNeighbours = new Set(); closeSpotlight(); renderer.refresh(); });
  const controls = document.createElement('div'); controls.className = 'sigmaControls';
  for (const [label, title, action] of [['+', 'Zoom in', () => renderer.getCamera().animatedZoom({ duration: 180 })], ['−', 'Zoom out', () => renderer.getCamera().animatedUnzoom({ duration: 180 })], ['⌂', 'Fit graph', () => renderer.getCamera().animatedReset({ duration: 260 })]]) { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.title = title; button.setAttribute('aria-label', title); button.addEventListener('click', action); controls.appendChild(button); }
  const count = document.createElement('p'); count.className = 'graphVisibleCount'; count.style.cssText = 'position:absolute;top:0;left:.5rem;right:.5rem;background:white;padding:.4rem;font-size:.7rem;pointer-events:none'; count.textContent = `${nodes.length} of ${model.nodes.length} nodes shown · select a node to explore its neighborhood`; count.setAttribute('role','status'); container.appendChild(count);
  container.appendChild(controls);
  renderer.getCamera().animatedReset({ duration: 420 });
  const freeze = () => { paused = true; if (frame) cancelAnimationFrame(frame); frame = null; simulation.stop(); };
  container.addEventListener('graph-freeze', freeze);
  active = { kill() { for (const node of simulationNodes) retainedPositions.set(node.id,{x:node.x,y:node.y}); container.removeEventListener('graph-freeze', freeze); container.removeEventListener('graph-layout-change',resize); if (frame) cancelAnimationFrame(frame); simulation.stop(); renderer.kill(); container.replaceChildren(); } };
  renderer.refresh();
  const instance = active;
  const cleanup = () => { if (active===instance) { active.kill(); active=null; } };
  cleanup.updateSelection = (id) => { if(!graph.hasNode(id))return false;selectedId=id;selectedNeighbours=new Set(graph.neighbors(id));renderer.refresh();return true; };
  return cleanup;

}
