import {test, expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {applyGraphCopyEdits, graphEvidenceHash, GRAPH_COPY_SKILL_COMMIT} from './graph-copy-edits.ts';
const resolve = () => 'Pete';

test('evidence hashes match hydrated legacy speaker labels without mutating stored evidence', () => {
 const {d}=fixture();
 d.exec("UPDATE knowledge_evidence SET speaker='Pete  •  00' WHERE id='v'");
 const repairedHash=graphEvidenceHash(d,'n',resolve);
 d.exec("UPDATE knowledge_evidence SET speaker='Pete' WHERE id='v'");
 expect(graphEvidenceHash(d,'n',resolve)).toBe(repairedHash);
 d.close();
});
function fixture(){
 const d=new Database(':memory:');
 d.exec(`CREATE TABLE episodes(id TEXT PRIMARY KEY,active_transcript_revision_id TEXT);
 CREATE TABLE transcript_revisions(id TEXT PRIMARY KEY,transcript_text TEXT);
 CREATE TABLE knowledge_nodes(id TEXT PRIMARY KEY,episode_id TEXT,source_transcript_revision_id TEXT,kind TEXT,title TEXT,summary TEXT,confidence REAL,review_state TEXT,origin TEXT,created_at INTEGER,updated_at INTEGER);
 CREATE TABLE knowledge_evidence(id TEXT PRIMARY KEY,knowledge_node_id TEXT,excerpt TEXT,speaker TEXT,transcript_start INTEGER,transcript_end INTEGER);
 CREATE TABLE audit_events(id TEXT PRIMARY KEY,actor_pubkey TEXT,action TEXT,entity_type TEXT,entity_id TEXT,detail_json TEXT,created_at INTEGER);
 CREATE TABLE knowledge_edges(id TEXT PRIMARY KEY,source_node_id TEXT,target_node_id TEXT);
 CREATE TABLE knowledge_snack_links(id TEXT PRIMARY KEY,knowledge_node_id TEXT,candidate_id TEXT);
 INSERT INTO episodes VALUES ('e','r'); INSERT INTO transcript_revisions VALUES ('r','Pete says: Keep the task board to check the work.');
 INSERT INTO knowledge_nodes VALUES ('n','e','r','claim','An audit surface','Task boards help review work.',0.8,'accepted','pipeline',1,1);
 INSERT INTO knowledge_nodes SELECT 'n2',episode_id,source_transcript_revision_id,kind,title,summary,confidence,review_state,origin,created_at,updated_at FROM knowledge_nodes WHERE id='n';
 INSERT INTO knowledge_evidence VALUES ('v','n','Keep the task board to check the work.',NULL,11,54);
 INSERT INTO knowledge_evidence VALUES ('v2','n2','Keep the task board to check the work.','Pete',11,54);
 INSERT INTO knowledge_edges VALUES ('edge','n','n2'); INSERT INTO knowledge_snack_links VALUES ('link','n','snack');`);
 const edit=(id='n')=>({id,episodeId:'e',expectedTranscriptRevisionId:'r',expectedTitle:'An audit surface',expectedSummary:'Task boards help review work.',expectedUpdatedAt:1,expectedEvidenceHash:graphEvidenceHash(d,id,resolve),title:'Use task boards to check the work',summary:'Task boards help review work.',reviewNote:'Checked wording against the source. No new claims.'});
 const body={batchId:'test-batch',skillCommit:GRAPH_COPY_SKILL_COMMIT,reviewMethod:'agent-source-review',edits:[edit()]};
 return {d,body,edit};
}
function run(fn:(f:ReturnType<typeof fixture>)=>void){const f=fixture();try{fn(f);}finally{f.d.close();}}
test('changes only copy and timestamp; preserves identity, evidence, links and provenance; records before/after',()=>run(({d,body})=>{
 const before=d.query('SELECT * FROM knowledge_nodes WHERE id="n"').get() as any;
 const immutable=['knowledge_evidence','knowledge_edges','knowledge_snack_links'].map(t=>d.query('SELECT * FROM '+t).all());
 expect(applyGraphCopyEdits(d,body,'editor',resolve)).toMatchObject({applied:true,count:1});
 const after=d.query('SELECT * FROM knowledge_nodes WHERE id="n"').get() as any;
 expect(after.title).toBe(body.edits[0]!.title);expect(after.updated_at).toBeGreaterThan(1);
 for(const k of Object.keys(before).filter(k=>!['title','summary','updated_at'].includes(k)))expect(after[k]).toEqual(before[k]);
 expect(['knowledge_evidence','knowledge_edges','knowledge_snack_links'].map(t=>d.query('SELECT * FROM '+t).all())).toEqual(immutable);
 const audit=JSON.parse((d.query("SELECT detail_json FROM audit_events WHERE action='graph-copy-edited'").get() as any).detail_json);
 expect(audit.before.title).toBe(before.title);expect(audit.after.title).toBe(after.title);expect(audit.reviewMethod).toBe('agent-source-review');
}));
test('identical replay changes nothing and conflicting reuse fails',()=>run(({d,body})=>{
 applyGraphCopyEdits(d,body,'editor',resolve);const before=d.serialize();
 expect(applyGraphCopyEdits(d,body,'editor',resolve)).toMatchObject({applied:false,replay:true});expect(d.serialize()).toEqual(before);
 const conflict=structuredClone(body);conflict.edits[0]!.title='A different edit';expect(()=>applyGraphCopyEdits(d,conflict,'editor',resolve)).toThrow('different content');
}));
for(const [name,sql,message] of [
 ['node copy',"UPDATE knowledge_nodes SET title='Other' WHERE id='n'",'Node changed'],
 ['node timestamp',"UPDATE knowledge_nodes SET updated_at=2 WHERE id='n'",'Node changed'],
 ['active source',"UPDATE episodes SET active_transcript_revision_id='new'",'Transcript changed'],
 ['node source',"UPDATE knowledge_nodes SET source_transcript_revision_id='new' WHERE id='n'",'Transcript changed'],
 ['evidence',"UPDATE knowledge_evidence SET excerpt='Different evidence' WHERE id='v'",'Evidence changed'],
 ['attribution',"UPDATE knowledge_evidence SET speaker='Andy' WHERE id='v'",'Evidence changed'],
 ['review state',"UPDATE knowledge_nodes SET review_state='rejected' WHERE id='n'",'accepted'],
] as const)test('rejects stale '+name,()=>run(({d,body})=>{d.exec(sql);const before=d.serialize();expect(()=>applyGraphCopyEdits(d,body,'editor',resolve)).toThrow(message);expect(d.serialize()).toEqual(before);}));
test('one invalid edit rejects the whole batch without changing the first node',()=>run(({d,body,edit})=>{
 body.edits.push({...edit('n2'),expectedTitle:'Stale'});expect(()=>applyGraphCopyEdits(d,body,'editor',resolve)).toThrow('Node changed');
 expect((d.query("SELECT title FROM knowledge_nodes WHERE id='n'").get() as any).title).toBe('An audit surface');expect(d.query('SELECT * FROM audit_events').all()).toEqual([]);
}));
test('audit failure rolls back every edit',()=>run(({d,body})=>{
 d.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'test audit failure'); END");
 expect(()=>applyGraphCopyEdits(d,body,'editor',resolve)).toThrow('test audit failure');expect((d.query("SELECT title FROM knowledge_nodes WHERE id='n'").get() as any).title).toBe('An audit surface');
}));
test('rejects duplicate nodes and injected semantic fields',()=>run(({d,body})=>{
 body.edits.push({...body.edits[0]!});expect(()=>applyGraphCopyEdits(d,body,'editor',resolve)).toThrow('Duplicate');body.edits.pop();
 (body.edits[0] as any).reviewState='rejected';expect(()=>applyGraphCopyEdits(d,body,'editor',resolve)).toThrow('fields');
}));
test('requires evidence, review attribution, pinned skill and bounded text',()=>run(({d,body})=>{
 const tryBody=(patch:any)=>expect(()=>applyGraphCopyEdits(d,{...body,...patch},'editor',resolve)).toThrow();
 tryBody({skillCommit:'other'});tryBody({reviewMethod:'human-reviewed'});tryBody({edits:[]});
 let invalid=structuredClone(body);invalid.edits[0]!.title=' ';expect(()=>applyGraphCopyEdits(d,invalid,'editor',resolve)).toThrow('text');
 d.exec("DELETE FROM knowledge_evidence WHERE knowledge_node_id='n'");expect(()=>applyGraphCopyEdits(d,body,'editor',resolve)).toThrow('evidence');
}));
