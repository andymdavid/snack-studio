import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {planKnowledgeIdentities} from './knowledge-identities.ts';
test('re-extraction preserves legacy source IDs despite reordered model keys; changed claims stay distinct',()=>{
 const db=new Database(':memory:');try{
 db.exec(`CREATE TABLE knowledge_nodes(id TEXT,episode_id TEXT,source_transcript_revision_id TEXT,kind TEXT,title TEXT,summary TEXT);CREATE TABLE knowledge_evidence(id TEXT,knowledge_node_id TEXT,excerpt TEXT,speaker TEXT);
 INSERT INTO knowledge_nodes VALUES('legacy-id','episode','revision','claim','Memory','Memory retains discoveries.');
 INSERT INTO knowledge_evidence VALUES('legacy-evidence','legacy-id','Exact source.','Pete');`);
 const node={key:'model-key',kind:'claim' as const,title:'Memory',summary:'Memory retains discoveries.',confidence:0.8,evidence:[{excerpt:'Exact source.',speaker:'Pete'}]};
 expect(planKnowledgeIdentities(db,'episode','revision',[node]).byKey.get('model-key')).toBe('legacy-id');
 expect(planKnowledgeIdentities(db,'episode','revision',[{...node,key:'different-key'}]).preserved.has('legacy-id')).toBeTrue();
 expect(planKnowledgeIdentities(db,'episode','revision',[{...node,summary:'Memory loses discoveries.'}]).preserved.size).toBe(0);
 expect(()=>planKnowledgeIdentities(db,'episode','revision',[node,{...node,key:'duplicate'}])).toThrow('Duplicate extracted');
 expect((db.query('SELECT id FROM knowledge_evidence').get() as {id:string}).id).toBe('legacy-evidence');
 }finally{db.close();}
});
