import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { installReconciliationSchema,registerObservation,createReconciliationBatch,submitReconciliationProposals,reviewReconciliationProposal,finishReconciliationBatch,acceptedReconciliation,redirectIdentity,type ReconciliationContext,type ReconciliationProposal } from './graph-reconciliation-store.ts';
import {retrieveArchiveCandidates,reconciliationPublicData} from './graph-reconciliation.ts';
import { loadReconciliationContext,reconciliationCoverage } from './graph-reconciliation.ts';
import { stageReconciliationAnalysis } from './graph-reconciliation-stage.ts';
import { importReviewedGraphPilot } from './graph-reconciliation-pilot.ts';
import { enqueueReconciliation } from './graph-reconciliation-store.ts';
const databases:Database[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();});
function fixture(){
 const db=new Database(':memory:');databases.push(db);db.exec('PRAGMA foreign_keys=ON');
 db.exec(`CREATE TABLE canonical_concepts(id TEXT PRIMARY KEY,title TEXT,summary TEXT,review_state TEXT,rationale TEXT,reviewed_by TEXT,updated_at INTEGER);
 CREATE TABLE canonical_concept_mentions(concept_id TEXT,knowledge_node_id TEXT,PRIMARY KEY(concept_id,knowledge_node_id));`);
 installReconciliationSchema(db);installReconciliationSchema(db);
 const transcript='Connected graph memory retains useful discoveries. Minimal harnesses compose external tools.';
 const make=(nodeId:string,episodeId:string,revisionId='rev-1',title='Graph memory')=>registerObservation(db,{nodeId,episodeId,revisionId,kind:'claim',title,summary:'Graph memory retains connected discoveries.',evidence:[{id:`ev-${nodeId}`,excerpt:transcript.slice(0,49),speaker:'Pete',start:0,end:49}]},transcript);
 const a=make('a','ep-a'),b=make('b','ep-b');const context:ReconciliationContext={observations:[a,b],concepts:[]};
 db.exec(`CREATE TABLE episodes(id TEXT PRIMARY KEY,active_transcript_revision_id TEXT);
 CREATE TABLE transcript_revisions(id TEXT PRIMARY KEY,transcript_text TEXT);
 CREATE TABLE knowledge_nodes(id TEXT PRIMARY KEY,episode_id TEXT,source_transcript_revision_id TEXT,kind TEXT,title TEXT,summary TEXT,review_state TEXT);
 CREATE TABLE knowledge_evidence(id TEXT PRIMARY KEY,knowledge_node_id TEXT,excerpt TEXT,speaker TEXT,transcript_start INTEGER,transcript_end INTEGER);`);
 db.query('INSERT INTO transcript_revisions VALUES(?1,?2)').run('rev-1',transcript);
 for(const o of [a,b]){db.query('INSERT INTO episodes VALUES(?1,?2)').run(o.episodeId,o.revisionId);db.query("INSERT INTO knowledge_nodes VALUES(?1,?2,?3,?4,?5,?6,'accepted')").run(o.nodeId,o.episodeId,o.revisionId,o.kind,o.title,o.summary);for(const e of o.evidence)db.query('INSERT INTO knowledge_evidence VALUES(?1,?2,?3,?4,?5,?6)').run(e.id,o.nodeId,e.excerpt,e.speaker,e.start,e.end);}
 const batch=createReconciliationBatch(db,'ep-a','rev-1',context);
 const proposal:ReconciliationProposal={key:'memory-parallel',kind:'relationship',sourceId:a.id,targetId:b.id,relationshipType:'parallels',explanation:'Both retain discoveries as connected memory; applications remain distinct.',evidence:[a,b].map(o=>({observationId:o.id,evidenceIds:o.evidence.map(e=>e.id)}))};
 return {db,transcript,make,a,b,context,batch,proposal};
}
test('observation snapshots replay and exact content preserves identity across source IDs/revisions',()=>{
 const {db,make,a}=fixture();expect(make('a','ep-a')).toEqual(a);
 const newer=make('a2','ep-a','rev-2');expect(newer.identityId).toBe(a.identityId);expect(newer.id).not.toBe(a.id);
 expect((db.query('SELECT COUNT(*) n FROM graph_observation_identities').get() as {n:number}).n).toBe(2);
});
test('evidence must point to the exact immutable transcript span',()=>{
 const {db,a,transcript}=fixture();expect(()=>registerObservation(db,{...a,nodeId:'bad',evidence:[{...a.evidence[0]!,start:1}]},transcript)).toThrow('exact source span');
});
test('changed meaning creates a distinct identity and retains history',()=>{
 const {make,a,db}=fixture();const changed=make('a-new','ep-a','rev-2','Graph memory may be unsafe');expect(changed.identityId).not.toBe(a.identityId);
 expect((db.query('SELECT COUNT(*) n FROM graph_observation_versions').get() as {n:number}).n).toBe(3);
});
test('no candidate links is a valid completed batch',()=>{
 const {db,batch,context}=fixture();submitReconciliationProposals(db,batch.id,[]);finishReconciliationBatch(db,batch.id,context,'editor','Reviewed all source observations in this fixture.');expect(acceptedReconciliation(db,context)).toEqual([]);
});
test('proposal replay is idempotent and changed replay is rejected',()=>{
 const {db,batch,proposal}=fixture();const first=submitReconciliationProposals(db,batch.id,[proposal]);expect(submitReconciliationProposals(db,batch.id,[proposal])).toEqual(first);
 expect(()=>submitReconciliationProposals(db,batch.id,[{...proposal,explanation:'Different'}])).toThrow('replay differs');
});
test('proposal validation is atomic, grounded at both ends and archive-only',()=>{
 const {db,batch,proposal,a}=fixture();expect(()=>submitReconciliationProposals(db,batch.id,[proposal,{...proposal,key:'bad',evidence:[]}])).toThrow('Evidence required');
 expect((db.query('SELECT COUNT(*) n FROM graph_reconciliation_proposals').get() as {n:number}).n).toBe(0);
 expect(()=>submitReconciliationProposals(db,batch.id,[{...proposal,targetId:a.id}])).toThrow('cross-episode');
 expect(()=>submitReconciliationProposals(db,batch.id,[{...proposal,evidence:[{observationId:a.id,evidenceIds:['invented']},proposal.evidence[1]!]}])).toThrow('endpoint evidence');
});
test('unreviewed and partly reviewed batches cannot publish',()=>{
 const {db,batch,proposal,context}=fixture();const [id]=submitReconciliationProposals(db,batch.id,[proposal]);expect(acceptedReconciliation(db,context)).toEqual([]);
 expect(()=>finishReconciliationBatch(db,batch.id,context,'editor','Reviewed all source observations in this fixture.')).toThrow('outstanding');
 reviewReconciliationProposal(db,id!,'accepted','editor','Checked both source passages',context);
 expect(acceptedReconciliation(db,context)).toEqual([]);finishReconciliationBatch(db,batch.id,context,'editor','Reviewed all source observations in this fixture.');expect(acceptedReconciliation(db,context)).toHaveLength(1);
});
test('rejections and explicit review metadata are retained and never published',()=>{
 const {db,batch,proposal,context}=fixture();const [id]=submitReconciliationProposals(db,batch.id,[proposal]);expect(()=>reviewReconciliationProposal(db,id!,'accepted','','',context)).toThrow('attribution');
 reviewReconciliationProposal(db,id!,'rejected','editor','Same topic, different meaning',context);finishReconciliationBatch(db,batch.id,context,'editor','Reviewed all source observations in this fixture.');expect(acceptedReconciliation(db,context)).toEqual([]);
 expect((db.query('SELECT rationale FROM graph_reconciliation_decisions').get() as {rationale:string}).rationale).toBe('Same topic, different meaning');
});
test('review replay creates no duplicate decisions and cannot overwrite prior decisions',()=>{
 const {db,batch,proposal,context}=fixture();const [id]=submitReconciliationProposals(db,batch.id,[proposal]);reviewReconciliationProposal(db,id!,'accepted','editor','Supported',context);
 expect(reviewReconciliationProposal(db,id!,'accepted','editor','Supported',context)).toEqual({replay:true});expect(()=>reviewReconciliationProposal(db,id!,'rejected','editor','Changed mind',context)).toThrow('already recorded');
 expect((db.query('SELECT COUNT(*) n FROM graph_reconciliation_decisions').get() as {n:number}).n).toBe(1);
});
test('concurrent archive changes block acceptance and stale endpoint revisions stop export',()=>{
 const {db,batch,proposal,context,a,make}=fixture();const [id]=submitReconciliationProposals(db,batch.id,[proposal]);const changed={...context,observations:[make('a-next','ep-a','rev-2'),context.observations[1]!]};
 expect(()=>reviewReconciliationProposal(db,id!,'accepted','editor','Supported',changed)).toThrow('Archive changed');
 reviewReconciliationProposal(db,id!,'accepted','editor','Supported',context);finishReconciliationBatch(db,batch.id,context,'editor','Reviewed all source observations in this fixture.');
 expect(acceptedReconciliation(db,changed)).toEqual([]);expect(acceptedReconciliation(db,context)[0]!.sourceId).toBe(a.id);
});
test('accepted relationships preserve source IDs, revisions and evidence in public export',()=>{
 const {db,batch,proposal,context}=fixture();const [id]=submitReconciliationProposals(db,batch.id,[proposal]);reviewReconciliationProposal(db,id!,'accepted','editor','Supported',context);finishReconciliationBatch(db,batch.id,context,'editor','Reviewed all source observations in this fixture.');
 expect(reconciliationPublicData(db,context,new Set(['a','b'])).relationshipRegistry.relationships[0]).toMatchObject({sourceId:'a',targetId:'b',reviewer:'editor',sources:[{nodeId:'a',transcriptRevisionId:'rev-1',evidenceIds:['ev-a']},{nodeId:'b',transcriptRevisionId:'rev-1',evidenceIds:['ev-b']}]});
 expect(reconciliationPublicData(db,context,new Set(['a'])).relationshipRegistry.relationships).toEqual([]);
});
test('concept assignment preserves distinct claims and creates canonical mentions only after completion',()=>{
 const {db,batch,context,a}=fixture();const proposal:ReconciliationProposal={key:'concept-memory',kind:'concept',sourceId:a.id,concept:{id:'graph-memory',title:'Graph memory',summary:'Connected records as retrievable memory.',aliases:['connected memory']},explanation:'This observation concerns connected retrievable memory.',evidence:[{observationId:a.id,evidenceIds:['ev-a']}]};
 const [id]=submitReconciliationProposals(db,batch.id,[proposal]);reviewReconciliationProposal(db,id!,'accepted','editor','Checked definition',context);
 expect(db.query('SELECT * FROM canonical_concepts').all()).toEqual([]);finishReconciliationBatch(db,batch.id,context,'editor','Reviewed all source observations in this fixture.');
 expect(db.query('SELECT * FROM canonical_concept_mentions').all()).toEqual([{concept_id:'graph-memory',knowledge_node_id:'a'}]);
 expect(reconciliationPublicData(db,context,new Set(['a','b'])).conceptRegistry.concepts[0]!.mentions).toEqual(['a']);
 expect(context.observations).toHaveLength(2);
});
test('identity merge redirects need attribution and cannot cycle',()=>{
 const {db,a,b}=fixture();redirectIdentity(db,a.identityId,b.identityId,'editor','Equivalent observations confirmed');
 expect(()=>redirectIdentity(db,b.identityId,a.identityId,'editor','Reverse')).toThrow('cycle');
 expect(()=>redirectIdentity(db,a.identityId,b.identityId,'','')).toThrow('review');
});
test('retrieval finds lexical/alias candidates but does not make decisions or force unrelated links',()=>{
 const {context,a,b,make}=fixture();const unrelated=make('c','ep-c','rev-1','Bitcoin');unrelated.summary='Lightning payments settle transactions.';
 const c={...context,observations:[a,b,unrelated],concepts:[{id:'memory',title:'Connected memory',summary:'Memory',aliases:['graph memory'],updatedAt:1}]};
 const result=retrieveArchiveCandidates(c,a);expect(result.candidates.map(c=>c.observation.nodeId)).toEqual(['b']);expect(result.concepts[0]!.concept.id).toBe('memory');expect(result).not.toHaveProperty('accepted');
 expect(()=>retrieveArchiveCandidates(c,a,500)).toThrow('limit');
});
test('completed batches cannot be reopened to add unreviewed proposals',()=>{
 const {db,batch,context,proposal}=fixture();submitReconciliationProposals(db,batch.id,[]);finishReconciliationBatch(db,batch.id,context,'editor','Reviewed all source observations in this fixture.');
 expect(()=>submitReconciliationProposals(db,batch.id,[proposal])).toThrow('immutable');
 expect(submitReconciliationProposals(db,batch.id,[])).toEqual([]);
});
test('independent critique stages complete source coverage without accepting its own output',()=>{
 const {db,batch,context,proposal,a}=fixture();enqueueReconciliation(db,'ep-a','rev-1');enqueueReconciliation(db,'ep-a','rev-1');
 const archive={batchId:batch.id,snapshot:batch.snapshot,episodeId:'ep-a',revisionId:'rev-1',sources:[{source:a}]};
 const result={batchId:batch.id,snapshot:batch.snapshot,proposals:[proposal],sourceAssessments:[{sourceId:a.id,rationale:'Inspected memory source.'}]};
 const critique={reviews:[{key:proposal.key,recommendation:'accept',rationale:'Source evidence supports parallel, not equivalence.'}]};
 expect(stageReconciliationAnalysis(db,archive,result,critique).status).toBe('needs-editorial-review');expect(acceptedReconciliation(db,context)).toEqual([]);
 expect((db.query('SELECT COUNT(*) n FROM graph_reconciliation_jobs').get() as {n:number}).n).toBe(1);
 expect(()=>stageReconciliationAnalysis(db,archive,{...result,sourceAssessments:[]},critique)).toThrow('Every source');
 expect(()=>stageReconciliationAnalysis(db,archive,result,{reviews:[]})).toThrow('independent critique');
});
test('pilot import preserves attribution, is replay safe, and does not count as full episode reconciliation',()=>{
 const {db}=fixture();
 const concepts=[{id:'graph-memory',title:'Graph memory',summary:'Connected retrievable records.',reviewState:'accepted',reviewer:'lara',reviewMethod:'agent-editorial-review',mentions:['a','b']}];
 const report=importReviewedGraphPilot(db,concepts,[]);expect(report.conceptMentions).toBe(2);expect(importReviewedGraphPilot(db,concepts,[]).replay).toBeTrue();
 const context=loadReconciliationContext(db);expect(reconciliationCoverage(db,context).every(e=>e.status!=='complete')).toBeTrue();expect(acceptedReconciliation(db,context)).toHaveLength(2);
});
test('ambiguous excerpts remain in source graph but cannot ground new archive decisions',()=>{
 const {db}=fixture();db.query("UPDATE knowledge_evidence SET excerpt='absent',transcript_start=NULL,transcript_end=NULL WHERE knowledge_node_id='a'").run();
 const context=loadReconciliationContext(db);expect(context.observations.map(o=>o.nodeId)).toEqual(['b']);expect(reconciliationCoverage(db,context).find(e=>e.episodeId==='ep-a')!.status).toBe('blocked-evidence');
 expect((db.query("SELECT COUNT(*) n FROM knowledge_nodes WHERE id='a'").get() as {n:number}).n).toBe(1);
});
test('acceptance rechecks live evidence inside the decision transaction',()=>{
 const {db,batch,context,proposal}=fixture();const [id]=submitReconciliationProposals(db,batch.id,[proposal]);
 db.query("UPDATE knowledge_evidence SET speaker='Different speaker' WHERE id='ev-b'").run();
 expect(()=>reviewReconciliationProposal(db,id!,'accepted','editor','Checked earlier snapshot',context)).toThrow('Source evidence changed');
 expect(db.query('SELECT * FROM graph_reconciliation_decisions').all()).toEqual([]);
});
test('schema additions roll back with a failed migration and leave source tables intact',()=>{
 const db=new Database(':memory:');databases.push(db);db.exec('CREATE TABLE canonical_concepts(id TEXT PRIMARY KEY)');
 expect(()=>db.transaction(()=>{installReconciliationSchema(db);throw new Error('simulated failure');})()).toThrow('simulated failure');
 expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='graph_observation_versions'").all()).toEqual([]);
 expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_concepts'").all()).toHaveLength(1);
});
