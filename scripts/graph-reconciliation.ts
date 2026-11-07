import { Database } from 'bun:sqlite';
import { writeFileSync } from 'node:fs';
import { installReconciliationSchema,submitReconciliationProposals,reviewReconciliationProposal,finishReconciliationBatch,contextSnapshot,type ReconciliationProposal } from '../src/graph-reconciliation-store.ts';
import { loadReconciliationContext,prepareEpisodeReconciliation,reconciliationCoverage,reconciliationPublicData,retrieveArchiveCandidates } from '../src/graph-reconciliation.ts';
import { importReviewedGraphPilot } from '../src/graph-reconciliation-pilot.ts';

// Explicit database path prevents accidentally operating on a developer's or
// production default database. Run backfill against a SQLite backup first.
const [command,...args]=process.argv.slice(2),options=new Map<string,string>();
for(let i=0;i<args.length;i+=2){if(!args[i]?.startsWith('--')||!args[i+1])throw new Error('Expected --key value pairs');options.set(args[i]!,args[i+1]!);}
const required=(key:string)=>{const value=options.get(`--${key}`);if(!value)throw new Error(`--${key} is required`);return value;};
const db=new Database(required('db'),{create:false});db.exec('PRAGMA foreign_keys=ON');
try{
 if(command==='install'){installReconciliationSchema(db);console.log(JSON.stringify({installed:true}));}
 else if(command==='import-pilot')console.log(JSON.stringify(importReviewedGraphPilot(db,(await Bun.file(required('concepts')).json()).concepts,(await Bun.file(required('relationships')).json()).relationships)));
 else if(command==='backfill'){
  const context=loadReconciliationContext(db),episodes=[...new Map(context.observations.map(o=>[o.episodeId,o.revisionId]))];
  const batches=episodes.map(([episodeId,revisionId])=>prepareEpisodeReconciliation(db,episodeId,revisionId));
  const report={mode:'dry-run-proposals-only',observations:context.observations.length,eligibleEpisodeCount:episodes.length,batches:batches.map(b=>({batchId:b.batchId,episodeId:b.episodeId,revisionId:b.revisionId,sourceCount:b.sources.length,candidatePairs:b.sources.reduce((n,s)=>n+s.candidates.length,0)})),coverage:reconciliationCoverage(db,context)};
  writeFileSync(required('out'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }else if(command==='prepare')console.log(JSON.stringify(prepareEpisodeReconciliation(db,required('episode'),required('revision'))));
 else if(command==='submit'){
  const payload=await Bun.file(required('input')).json(),current=loadReconciliationContext(db);
  const batch=db.query('SELECT snapshot FROM graph_reconciliation_batches WHERE id=?1').get(String(payload.batchId)) as {snapshot:string}|null;
  if(!batch||batch.snapshot!==payload.snapshot||payload.snapshot!==contextSnapshot(current))throw new Error('Stale proposal snapshot');
  console.log(JSON.stringify({proposalIds:submitReconciliationProposals(db,String(payload.batchId),payload.proposals as ReconciliationProposal[])}));
 }else if(command==='review'){
  const decision=required('decision');if(!['accepted','rejected'].includes(decision))throw new Error('Invalid decision');
  console.log(JSON.stringify(reviewReconciliationProposal(db,required('proposal'),decision as 'accepted'|'rejected',required('reviewer'),required('rationale'),loadReconciliationContext(db),options.get('--method')||'editor-explicit-review')));
 }else if(command==='finish'){
  finishReconciliationBatch(db,required('batch'),loadReconciliationContext(db),required('reviewer'),required('rationale'));console.log(JSON.stringify({complete:true}));
 }else if(command==='export'){
  const context=loadReconciliationContext(db),ids=new Set(context.observations.map(o=>o.nodeId));
  writeFileSync(required('out'),JSON.stringify({...reconciliationPublicData(db,context,ids),coverage:reconciliationCoverage(db,context)},null,2)+'\n');console.log(JSON.stringify({written:required('out')}));
 }else if(command==='evaluate'){
  const context=loadReconciliationContext(db),sample=await Bun.file(required('input')).json() as Array<{sourceNodeId:string;positiveTargetIds:string[];negativeTargetIds:string[]}>;
  let positives=0,hits=0,negativeHits=0;
  const cases=sample.map(row=>{
   const source=context.observations.find(o=>o.nodeId===row.sourceNodeId);if(!source)throw new Error(`Ungrounded evaluation source ${row.sourceNodeId}`);
   const result=retrieveArchiveCandidates(context,source),found=new Set(result.candidates.map(c=>c.observation.nodeId));positives+=row.positiveTargetIds.length;hits+=row.positiveTargetIds.filter(id=>found.has(id)).length;negativeHits+=row.negativeTargetIds.filter(id=>found.has(id)).length;
   return {sourceNodeId:row.sourceNodeId,found:[...found],missed:row.positiveTargetIds.filter(id=>!found.has(id)),negativeCandidates:row.negativeTargetIds.filter(id=>found.has(id))};
  });
  console.log(JSON.stringify({retrievalVersion:'lexical-alias-v1',cases,positiveCandidates:positives,retrievedPositives:hits,recall:positives?hits/positives:null,negativeCandidates:negativeHits,warning:'Small reviewed fixture only; does not estimate archive-wide precision.'}));
 }else throw new Error('Expected install, backfill, prepare, submit, review, finish, export or evaluate');
}finally{db.close();}
