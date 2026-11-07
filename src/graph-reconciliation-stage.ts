import type { Database } from 'bun:sqlite';
import { loadReconciliationContext } from './graph-reconciliation.ts';
import { contextSnapshot, submitReconciliationProposals, type ReconciliationProposal, RECONCILIATION_VERSION } from './graph-reconciliation-store.ts';

export function stageReconciliationAnalysis(db:Database,archive:{batchId:string;snapshot:string;episodeId:string;revisionId:string;sources:Array<{source:{id:string}}>},result:{batchId:string;snapshot:string;proposals:ReconciliationProposal[];sourceAssessments:Array<{sourceId:string;rationale:string}>},critique:{reviews:Array<{key:string;recommendation:string;rationale:string}>}){
 if(result.batchId!==archive.batchId||result.snapshot!==archive.snapshot)throw new Error('Analysis targets a different batch');
 const current=loadReconciliationContext(db),batch=db.query('SELECT snapshot,episode_id,revision_id FROM graph_reconciliation_batches WHERE id=?1').get(archive.batchId) as {snapshot:string;episode_id:string;revision_id:string}|null;
 if(!batch||batch.snapshot!==archive.snapshot||batch.episode_id!==archive.episodeId||batch.revision_id!==archive.revisionId||contextSnapshot(current)!==archive.snapshot)throw new Error('Archive changed during analysis');
 const sourceIds=new Set(current.observations.filter(o=>o.episodeId===batch.episode_id&&o.revisionId===batch.revision_id).map(o=>o.id));
 if(!Array.isArray(result.sourceAssessments)||result.sourceAssessments.length!==sourceIds.size||new Set(result.sourceAssessments.map(s=>s.sourceId)).size!==sourceIds.size||result.sourceAssessments.some(s=>!sourceIds.has(s.sourceId)||!s.rationale?.trim()))throw new Error('Every source needs an explicit assessment');
 if(!Array.isArray(result.proposals)||!Array.isArray(critique.reviews)||critique.reviews.length!==result.proposals.length||new Set(critique.reviews.map(r=>r.key)).size!==result.proposals.length||critique.reviews.some(r=>!result.proposals.some(p=>p.key===r.key)||!['accept','reject','needs-review'].includes(r.recommendation)||!r.rationale?.trim()))throw new Error('Every proposal needs an independent critique');
 // A critic recommendation is retained for the editor, never automatically
 // converted into an acceptance decision before the matching policy is calibrated.
 return db.transaction(()=>{
  const proposalIds=submitReconciliationProposals(db,archive.batchId,result.proposals);
  db.exec('CREATE TABLE IF NOT EXISTS graph_reconciliation_analyses(batch_id TEXT PRIMARY KEY,analysis_json TEXT NOT NULL,critique_json TEXT NOT NULL,created_at INTEGER NOT NULL)');
  const prior=db.query('SELECT analysis_json,critique_json FROM graph_reconciliation_analyses WHERE batch_id=?1').get(archive.batchId) as {analysis_json:string;critique_json:string}|null;
  const analysisJson=JSON.stringify(result),critiqueJson=JSON.stringify(critique);
  if(prior&&(prior.analysis_json!==analysisJson||prior.critique_json!==critiqueJson))throw new Error('Analysis replay changed; prepare a new reviewed attempt');
  db.query('INSERT OR IGNORE INTO graph_reconciliation_analyses VALUES(?1,?2,?3,?4)').run(archive.batchId,analysisJson,critiqueJson,Date.now());
  db.query("UPDATE graph_reconciliation_jobs SET status='review',batch_id=?3,error=NULL,updated_at=?4 WHERE episode_id=?1 AND revision_id=?2 AND contract_version=?5").run(archive.episodeId,archive.revisionId,archive.batchId,Date.now(),RECONCILIATION_VERSION);
  return {status:'needs-editorial-review',batchId:archive.batchId,proposalIds,sourceCount:sourceIds.size};
 })();
}
