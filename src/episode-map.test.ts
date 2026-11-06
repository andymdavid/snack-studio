import {expect,test} from 'bun:test';
// @ts-expect-error JavaScript renderer model is intentionally shared with the public bundle.
import {deriveEpisodeMap} from './episode-map.js';
test('episode map groups all episode ideas without structural hubs or unrelated episodes',()=>{
 const model={nodes:[{id:'episode:e',kind:'episode',episodeId:'e',title:'Episode'},{id:'root',kind:'root',episodeId:''},{id:'p',kind:'host',episodeId:''},{id:'c',kind:'claim',episodeId:'e'},{id:'s',kind:'snack',episodeId:'e'},{id:'other',kind:'claim',episodeId:'other'}],allConnections:[{sourceId:'p',targetId:'episode:e',relationshipType:'hosted'},{sourceId:'episode:e',targetId:'c',relationshipType:'develops'},{sourceId:'c',targetId:'s',relationshipType:'developed-into'},{sourceId:'c',targetId:'other',relationshipType:'supports'}]};
 const view=deriveEpisodeMap(model,'e');expect(view.nodes.map((n:any)=>n.id)).toEqual(['c','s']);expect(view.people.map((n:any)=>n.id)).toEqual(['p']);expect(view.totalNodes).toBe(4);expect(view.groups.map((g:any)=>g.kind)).toEqual(['claim','snack']);expect(view.edges).toHaveLength(1);expect(deriveEpisodeMap(model,'missing')).toBeNull();
});
