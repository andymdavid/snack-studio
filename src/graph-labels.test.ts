import {expect,test} from 'bun:test';
// @ts-expect-error Browser helper shared as native JavaScript.
import {compactGraphLabel,placeGraphLabels} from './graph-labels.js';
test('labels remain short while preserving canonical full titles',()=>{const n={kind:'claim',title:'This is a long claim that should never occupy the entire graph'};expect(compactGraphLabel(n)).toHaveLength(26);expect(n.title).toContain('entire graph');expect(compactGraphLabel({kind:'episode',episodeNumber:78,title:'Episode 78 · The Last Invention'})).toBe('Episode 78');});
test('dense neighborhood labels fit viewport, avoid each other and prioritize selection',()=>{
 const nodes=Array.from({length:41},(_,i)=>({id:`n${i}`,kind:'claim',title:`An idea with an explanatory title ${i}`,x:80+(i%7)*95,y:80+Math.floor(i/7)*80,size:6}));
 const options={width:800,height:650,selectedId:'n40',measureText:(text:string)=>text.length*5.5};const labels=placeGraphLabels(nodes,options);expect(labels[0]?.id).toBe('n40');expect(labels.length).toBeLessThanOrEqual(5);
 for(const a of labels){expect(a.x).toBeGreaterThanOrEqual(14);expect(a.x+a.width).toBeLessThanOrEqual(786);for(const b of labels)if(a!==b)expect(a.x>=b.x+b.width||b.x>=a.x+a.width||a.y>=b.y+b.height||b.y>=a.y+a.height).toBe(true);}
 expect(placeGraphLabels(nodes,{...options,zoom:.2}).length).toBeGreaterThan(labels.length);
});
