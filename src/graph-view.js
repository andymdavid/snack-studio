export const isIdeaNode = node => ['concept','claim','example','question','canonical'].includes(node.kind);
export function buildIdeaProjection(model) {
 const eligible=model.nodes.filter(isIdeaNode),byId=new Map(eligible.map(node=>[node.id,node]));
 const edges=model.allConnections.filter(edge=>byId.has(edge.sourceId)&&byId.has(edge.targetId));
 const neighbours=new Map(eligible.map(node=>[node.id,new Set()]));
 for(const edge of edges){neighbours.get(edge.sourceId).add(edge.targetId);neighbours.get(edge.targetId).add(edge.sourceId);}
 const seen=new Set(),components=[];
 for(const node of eligible){if(seen.has(node.id))continue;const stack=[node.id],ids=[];
  while(stack.length){const id=stack.pop();if(seen.has(id))continue;seen.add(id);ids.push(id);for(const next of neighbours.get(id))if(!seen.has(next))stack.push(next);}
  const episodes=new Set(ids.map(id=>byId.get(id).episodeId).filter(Boolean));components.push({id:[...ids].sort()[0],ids,episodeReach:episodes.size});
 }
 components.sort((a,b)=>b.episodeReach-a.episodeReach||b.ids.length-a.ids.length||a.id.localeCompare(b.id));
 const componentByNode=new Map(components.flatMap(component=>component.ids.map(id=>[id,component])));
 const nodes=eligible.map(node=>({...node,layoutGroup:componentByNode.get(node.id).id,semanticDegree:neighbours.get(node.id).size,crossEpisodeDegree:[...neighbours.get(node.id)].filter(id=>node.episodeId&&byId.get(id).episodeId&&node.episodeId!==byId.get(id).episodeId).length}));
 return {nodes,allConnections:edges,components,neighbours};
}
export function selectIdeaView(model,options={}) {
 const projection=buildIdeaProjection(model),byId=new Map(projection.nodes.map(node=>[node.id,node]));
 const limit=Math.max(1,options.limit||model.viewLimit||320),picked=new Set();
 const focus=Object.hasOwn(options,'focusId')?options.focusId:model.focus?.id;
 const groups=model.ideaScope==='pilot'?projection.components.filter(group=>group.ids.some(id=>byId.get(id).kind==='canonical')):projection.components;
 const allowed=new Set(groups.flatMap(group=>group.ids));
 const add=id=>{if(allowed.has(id))picked.add(id);};
 if(focus&&allowed.has(focus)){
  add(focus);for(const id of projection.neighbours.get(focus))add(id);
 }
 // Shared concepts and bridges lead; interleave semantic components rather than
 // imposing episode quotas or treating repeated source mentions as importance.
 for(const group of groups)if(group.ids.some(id=>byId.get(id).kind==='canonical'))for(const id of group.ids)add(id);
 const ranked=groups.map(group=>group.ids.sort((a,b)=>byId.get(b).crossEpisodeDegree-byId.get(a).crossEpisodeDegree||byId.get(b).semanticDegree-byId.get(a).semanticDegree||a.localeCompare(b)));
 for(let offset=0;picked.size<Math.min(limit,allowed.size);offset++){
  let added=false;for(const group of ranked)if(group[offset]&&picked.size<limit){add(group[offset]);added=true;}
  if(!added)break;
 }
 const nodes=projection.nodes.filter(node=>picked.has(node.id));
 return {nodes,allConnections:projection.allConnections.filter(edge=>picked.has(edge.sourceId)&&picked.has(edge.targetId)),totalNodes:projection.nodes.length,hiddenNodes:projection.nodes.length-nodes.length,components:groups};
}
export function ideaDiscovery(model) {
 const projection=buildIdeaProjection(model),byId=new Map(projection.nodes.map(node=>[node.id,node]));
 const latest=[...new Set(model.nodes.filter(node=>node.kind==='episode').map(node=>node.episodeNumber))].sort((a,b)=>b-a).slice(0,5);
 const shared=projection.nodes.filter(node=>node.kind==='canonical').map(node=>{const sources=[...projection.neighbours.get(node.id)].map(id=>byId.get(id));const numbers=[...new Set(sources.map(node=>node.episodeNumber).filter(Boolean))].sort((a,b)=>a-b);return {...node,episodeReach:numbers.length,episodes:numbers,recentEpisodes:numbers.filter(number=>latest.includes(number)).length};}).sort((a,b)=>b.episodeReach-a.episodeReach||a.title.localeCompare(b.title));
 const recent=[];for(const number of latest){const idea=projection.nodes.filter(node=>node.kind==='concept'&&node.episodeNumber===number).sort((a,b)=>b.semanticDegree-a.semanticDegree||a.id.localeCompare(b.id))[0];if(idea)recent.push(idea);if(recent.length===3)break;}
 return {shared,recent,latestEpisodes:latest,reviewedCrossEpisodeLinks:model.allConnections.filter(edge=>edge.reviewedRelationshipId&&byId.get(edge.sourceId)?.episodeId!==byId.get(edge.targetId)?.episodeId).length};
}

// Keep navigation gateways independent of the content budget. Focus enriches the
// map rather than isolating a cluster and removing routes to other episodes.
export function selectGraphView(model, options = {}) {
  if(model.displayMode==='ideas')return selectIdeaView(model,options);
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
