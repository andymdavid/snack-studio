export function compactGraphLabel(node, maximum = 26) {
  if (node.kind === 'episode' && node.episodeNumber) return `Episode ${node.episodeNumber}`;
  if (node.kind === 'root') return 'Intelligence Snacks';
  const title = String(node.title || '').trim();
  return title.length > maximum ? `${title.slice(0,maximum-1).trimEnd()}…` : title;
}
const intersects = (a,b,gap=5) => a.x < b.x+b.width+gap && a.x+a.width+gap > b.x && a.y < b.y+b.height+gap && a.y+a.height+gap > b.y;
export function placeGraphLabels(nodes, options) {
  const {width,height,zoom=1,selectedId,hoveredId,measureText} = options;
  const budget = Math.min(24, Math.max(4,Math.min(8,Math.floor(width*height/110000))) + (zoom<0.55?5:0) + (zoom<0.25?8:0));
  const rank = node => node.id===hoveredId ? 100 : node.id===selectedId ? 90 : ({episode:15,canonical:12,host:9,contributor:7,root:6,concept:4,claim:3,snack:2,example:1,question:1}[node.kind] || 0);
  const labels=[];
  const ordered=[...nodes].sort((a,b)=>rank(b)-rank(a)||a.id.localeCompare(b.id));
  for (const node of ordered) {
    if(labels.length>=budget)break;
    const text=compactGraphLabel(node);if(!text)continue;
    const labelWidth=measureText(text)+10,labelHeight=18,radius=node.size+7;
    const positions=[{x:node.x+radius,y:node.y-9},{x:node.x-radius-labelWidth,y:node.y-9},{x:node.x-labelWidth/2,y:node.y-radius-labelHeight},{x:node.x-labelWidth/2,y:node.y+radius}];
    if(node.id===selectedId||node.id===hoveredId)positions.push({x:14,y:52},{x:width-labelWidth-14,y:52});
    const position=positions.find(rect=>{
      const box={...rect,width:labelWidth,height:labelHeight};
      return box.x>=14&&box.y>=40&&box.x+box.width<=width-14&&box.y+box.height<=height-46&&!labels.some(label=>intersects(box,label))&&!nodes.some(other=>other.id!==node.id&&intersects(box,{x:other.x-other.size-2,y:other.y-other.size-2,width:other.size*2+4,height:other.size*2+4},2));
    });
    if(position)labels.push({id:node.id,text,...position,width:labelWidth,height:labelHeight,nodeX:node.x,nodeY:node.y,active:node.id===selectedId||node.id===hoveredId});
  }
  return labels;
}
