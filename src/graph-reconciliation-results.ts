import type {Database} from 'bun:sqlite';
import {db as appDb} from './db.ts';
import {getPipelineRequest,getPipelineRun} from './pipeline-requests.ts';
import {prepareEpisodeReconciliation} from './graph-reconciliation.ts';
import {stageReconciliationAnalysis} from './graph-reconciliation-stage.ts';
import {digest,type ReconciliationProposal} from './graph-reconciliation-store.ts';

export const ARCHIVE_RECONCILIATION_CONTRACT={pipelineName:'snack-studio-archive-reconciliation',pipelineVersion:'2',promptSuiteVersion:'v2-api-archive-reconciliation',resultSchemaVersion:'6'} as const;
export function listReconciliationJobs(db:Database=appDb){
 const jobs=db.query("SELECT j.episode_id episodeId,j.revision_id transcriptRevisionId,j.status FROM graph_reconciliation_jobs j JOIN episodes e ON e.id=j.episode_id WHERE j.revision_id=e.active_transcript_revision_id AND j.contract_version='1' ORDER BY j.updated_at").all() as Array<{episodeId:string;transcriptRevisionId:string;status:string}>;
 return jobs.map(job=>{
  const request=db.query('SELECT status FROM pipeline_requests WHERE episode_id=?1 AND input_transcript_revision_id=?2 AND pipeline_name=?3 AND pipeline_version=?4 ORDER BY created_at DESC LIMIT 1').get(job.episodeId,job.transcriptRevisionId,ARCHIVE_RECONCILIATION_CONTRACT.pipelineName,ARCHIVE_RECONCILIATION_CONTRACT.pipelineVersion) as {status:string}|null;
  const processing=request&&['created','awaiting-authorization','queued','running','applying-result'].includes(request.status);
  return {...job,status:job.status==='complete'?'complete':request?.status==='awaiting-authorization'?'awaiting-authorization':processing?'processing':request?.status==='completed'?'review':request&&['failed','timed-out','cancelled','needs-review'].includes(request.status)?'failed':job.status};
 });
}
export type ReconciliationResult={requestId:string;attemptId:string;episodeId:string;inputRevisionId:string;operation:'publication-metadata';pipelineVersion:'2';resultSchemaVersion:'6';batchId:string;snapshot:string;proposalResult:{batchId:string;snapshot:string;proposals:ReconciliationProposal[];sourceAssessments:Array<{sourceId:string;rationale:string}>};critique:{reviews:Array<{key:string;recommendation:string;rationale:string}>}};

export function validateReconciliationResult(body:Record<string,unknown>):{ok:true;value:ReconciliationResult}|{ok:false;error:string}{
 if(body.operation!=='publication-metadata'||body.pipelineVersion!=='2'||body.resultSchemaVersion!=='6')return {ok:false,error:'Archive reconciliation callback contract mismatch'};
 for(const key of ['requestId','attemptId','episodeId','inputRevisionId','batchId','snapshot'])if(typeof body[key]!=='string'||!(body[key] as string).trim())return {ok:false,error:`${key} is required`};
 if(!body.proposalResult||typeof body.proposalResult!=='object'||!body.critique||typeof body.critique!=='object')return {ok:false,error:'Proposal analysis and independent critique required'};
 return {ok:true,value:body as ReconciliationResult};
}

function checkedRequest(db:Database,requestId:string,attemptId:string){
 const request=getPipelineRequest(requestId,db),run=getPipelineRun(attemptId,db);
 if(!request||!run||run.requestId!==request.id||request.pipelineName!==ARCHIVE_RECONCILIATION_CONTRACT.pipelineName||request.operation!=='publication-metadata'||request.pipelineVersion!=='2'||request.resultSchemaVersion!=='6'||request.promptSuiteVersion!==ARCHIVE_RECONCILIATION_CONTRACT.promptSuiteVersion)throw new Error('Reconciliation request/attempt contract mismatch');
 const latest=db.query('SELECT id FROM pipeline_runs WHERE request_id=?1 ORDER BY attempt_number DESC LIMIT 1').get(requestId) as {id:string}|null;
 if(latest?.id!==attemptId||['cancelled','error','timed-out'].includes(run.status)||['cancelled','failed','timed-out'].includes(request.status))throw new Error('Reconciliation attempt is no longer active');
 const active=db.query('SELECT active_transcript_revision_id revision FROM episodes WHERE id=?1').get(request.episodeId) as {revision:string}|null;
 if(!active||active.revision!==request.inputTranscriptRevisionId)throw new Error('Transcript revision changed; start a new reconciliation request');
 return {request,run};
}

export function prepareReconciliationRequest(requestId:string,attemptId:string,actor:string,db:Database=appDb){
 const {request}=checkedRequest(db,requestId,attemptId);
 if(request.actorPubkey!==actor)throw new Error('Reconciliation context belongs to a different actor');
 return db.transaction(()=>{
  const archive=prepareEpisodeReconciliation(db,request.episodeId,request.inputTranscriptRevisionId);
  const id=`archive-context-${digest([requestId,attemptId])}`;
  const content=JSON.stringify({batchId:archive.batchId,snapshot:archive.snapshot});
  const prior=db.query('SELECT content_json FROM pipeline_artifacts WHERE id=?1').get(id) as {content_json:string}|null;
  if(prior&&prior.content_json!==content)throw new Error('Archive changed during this attempt; prepare a fresh request');
  db.query("INSERT OR IGNORE INTO pipeline_artifacts(id,request_id,run_id,artifact_type,schema_version,content_json,created_at) VALUES(?1,?2,?3,'archive-reconciliation-context','6',?4,?5)").run(id,requestId,attemptId,content,Date.now());
  return {requestId,attemptId,episodeId:request.episodeId,inputRevisionId:request.inputTranscriptRevisionId,archive};
 })();
}

export function applyReconciliationResult(result:ReconciliationResult,localRunId:string,db:Database=appDb){
 const {request}=checkedRequest(db,result.requestId,localRunId);
 if(result.attemptId!==localRunId||result.episodeId!==request.episodeId||result.inputRevisionId!==request.inputTranscriptRevisionId)throw new Error('Reconciliation callback source mismatch');
 const context=db.query("SELECT content_json FROM pipeline_artifacts WHERE id=?1 AND request_id=?2 AND run_id=?3").get(`archive-context-${digest([result.requestId,localRunId])}`,result.requestId,localRunId) as {content_json:string}|null;
 if(!context||context.content_json!==JSON.stringify({batchId:result.batchId,snapshot:result.snapshot}))throw new Error('Callback does not match prepared reconciliation context');
 const batch=db.query('SELECT context_json FROM graph_reconciliation_batches WHERE id=?1').get(result.batchId) as {context_json:string}|null;
 if(!batch)throw new Error('Unknown reconciliation batch');
 const sources=JSON.parse(batch.context_json).observations.filter((o:any)=>o.episodeId===request.episodeId&&o.revisionId===request.inputTranscriptRevisionId).map((source:any)=>({source:{id:source.id}}));
 return db.transaction(()=>{
  const staged=stageReconciliationAnalysis(db,{batchId:result.batchId,snapshot:result.snapshot,episodeId:request.episodeId,revisionId:request.inputTranscriptRevisionId,sources},result.proposalResult,result.critique);
  const now=Date.now();
  db.query("UPDATE pipeline_runs SET status='complete',progress_percent=100,progress_label='Archive proposals ready for editorial review',completed_at=?2,updated_at=?2 WHERE id=?1").run(localRunId,now);
  db.query("UPDATE pipeline_requests SET status='completed',result_applied_at=?2,failure_summary=NULL,updated_at=?2 WHERE id=?1").run(request.id,now);
  return staged;
 })();
}
