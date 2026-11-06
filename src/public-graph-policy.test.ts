import { expect, test } from 'bun:test';
import { eligibleKnowledgeGraph } from './public-graph-policy';
import { resolvePublishedSnack } from './published-manifest';
import { selectGraphView } from './graph-view.js';
test('public graph excludes proposed, rejected, stale and private knowledge',()=>{
 const make=(id:string,reviewState='accepted',sourceTranscriptRevisionId='r',episodeId='e')=>({id,reviewState,sourceTranscriptRevisionId,episodeId});
 expect(eligibleKnowledgeGraph([make('yes'),make('proposed','proposed'),make('rejected','rejected'),make('stale','accepted','old'),make('private','accepted','r','private')],new Map([['e','r']]),new Set(['e'])).map(n=>n.id)).toEqual(['yes']);
});
test('canonical publication uses stable identity after a title change and never guesses unmatched drafts',()=>{
 const candidate={candidateId:'c',title:'Edited title',standfirst:'Edited summary',episodeNumber:64};
 expect(resolvePublishedSnack(candidate,[{slug:'stable-url',candidateId:'c',title:'Published title',standfirst:'Published copy',sourceEpisode:'episode-064'}])?.slug).toBe('stable-url');
 expect(resolvePublishedSnack(candidate,[{slug:'different-snack',title:'Other title',standfirst:'Other copy',sourceEpisode:'episode-064'}])).toBeNull();
});
test('over-500 graph preserves explicit focus and reachable neighborhood rather than array order',()=>{
 const nodes=Array.from({length:700},(_,i)=>({id:`n${i}`,kind:'concept',episodeId:`e${i%20}`}));
 const model={nodes,allConnections:[{sourceId:'n699',targetId:'n600'}]};
 const view=selectGraphView(model,{focusId:'n699',limit:160});
 expect(view.nodes.map((n:any)=>n.id)).toEqual(['n600','n699']);expect(view.totalNodes).toBe(700);expect(view.hiddenNodes).toBe(698);expect(view.allConnections.length).toBe(1);
 const overview=selectGraphView(model,{limit:160});expect(new Set(overview.nodes.map((n:any)=>n.episodeId)).size).toBe(20);
});
