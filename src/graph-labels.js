export function compactGraphLabel(node, maximum = 26) {
  if (node.kind === 'episode' && node.episodeNumber) return `Episode ${node.episodeNumber}`;
  if (node.kind === 'root') return 'Intelligence Snacks';
  const title = String(node.title || '').trim();
  return title.length > maximum ? `${title.slice(0,maximum-1).trimEnd()}…` : title;
}
const intersects = (a,b,gap=5) => a.x < b.x+b.width+gap && a.x+a.width+gap > b.x && a.y < b.y+b.height+gap && a.y+a.height+gap > b.y;
export function placeGraphLabels(nodes, options) {
  const {width,height,zoom=1,selectedId,hoveredId,focusEpisodeId,measureText} = options;
  const budget = Math.min(24, Math.max(4,Math.min(8,Math.floor(width*height/110000))) + (zoom<0.55?5:0) + (zoom<0.25?8:0));
  const rank = node => node.kind==='episode' ? (node.id===selectedId?240:200) : node.id===hoveredId ? 100 : node.id===selectedId ? 90 : (focusEpisodeId&&node.episodeId===focusEpisodeId?20:0)+({episode:60,canonical:12,host:9,contributor:7,root:6,concept:4,claim:3,snack:2,example:1,question:1}[node.kind] || 0);
  const mobileSlots=new Map();
  if(width<600){const episodes=nodes.filter(node=>node.kind==='episode').sort((a,b)=>a.x-b.x);const split=Math.ceil(episodes.length/2);for(const [side,group] of [[-1,episodes.slice(0,split)],[1,episodes.slice(split)]])group.sort((a,b)=>a.y-b.y).forEach((node,index)=>mobileSlots.set(node.id,{side,y:44+index*Math.min(25,(height-152)/Math.max(1,split-1))}));}
  const labels=[];
  const ordered=[...nodes].sort((a,b)=>rank(b)-rank(a)||a.id.localeCompare(b.id));
  for (const node of ordered) {
    if(node.kind !== 'episode' && labels.filter(label => label.kind !== 'episode').length>=budget)continue;
    const text=compactGraphLabel(node);if(!text)continue;
    const labelWidth=measureText(text)+10,labelHeight=18,radius=node.size+7;
    const positions=[{x:node.x+radius,y:node.y-9},{x:node.x-radius-labelWidth,y:node.y-9},{x:node.x-labelWidth/2,y:node.y-radius-labelHeight},{x:node.x-labelWidth/2,y:node.y+radius}];
    if(node.id===selectedId||node.id===hoveredId){for(const distance of [24,44,64,84,104])for(let angle=0;angle<8;angle++)positions.push({x:node.x+Math.cos(angle*Math.PI/4)*distance-labelWidth/2,y:node.y+Math.sin(angle*Math.PI/4)*distance-9});}
    if(node.kind==='episode'){
      const dx=node.x-width/2,dy=node.y-height/2,length=Math.hypot(dx,dy)||1;
      const outward=[24,44,64,84,104].map(distance=>({x:node.x+dx/length*distance+(dx>=0?0:-labelWidth),y:node.y+dy/length*distance-9}));
      if(length>80)positions.unshift(...outward);
      // Keep every gateway identifiable at fitted zoom. If its cluster is too
      // crowded, use the outer margin with a leader line rather than omit it.
      for(const offset of [0,-22,22,-44,44,-66,66])positions.push({x:Math.max(14,Math.min(width-labelWidth-14,node.x+(dx>=0?100:-100-labelWidth))),y:Math.max(42,Math.min(height-110,node.y-9+offset))});
      for(const offset of [0,-22,22,-44,44,-66,66,-88,88,-110,110,-132,132,-154,154,-176,176,-198,198,-220,220])positions.push({x:dx>=0?width-labelWidth-18:18,y:Math.max(42,Math.min(height-110,node.y-9+offset))});
      const gutterRows=[];for(let y=44;y+labelHeight<=height-90;y+=24)gutterRows.push(y);gutterRows.sort((a,b)=>Math.abs(a-node.y)-Math.abs(b-node.y));
      for(const y of gutterRows)for(const side of (dx>=0?[1,-1]:[-1,1]))positions.push({x:side>0?width-labelWidth-18:18,y});
    }
    const slot=mobileSlots.get(node.id);if(slot)positions.unshift({x:slot.side>0?width-labelWidth-18:18,y:slot.y});
    if(node.id===selectedId||node.id===hoveredId)positions.push({x:14,y:52},{x:width-labelWidth-14,y:52});
    const position=positions.find(rect=>{
      const box={...rect,width:labelWidth,height:labelHeight};
      return box.x>=14&&box.y>=40&&box.x+box.width<=width-14&&box.y+box.height<=height-90&&!labels.some(label=>intersects(box,label))&&!nodes.some(other=>other.id!==node.id&&intersects(box,{x:other.x-other.size-2,y:other.y-other.size-2,width:other.size*2+4,height:other.size*2+4},2));
    });
    if(position)labels.push({id:node.id,kind:node.kind,text,...position,width:labelWidth,height:labelHeight,nodeX:node.x,nodeY:node.y,active:node.id===selectedId||node.id===hoveredId});
  }
  return labels;
}
