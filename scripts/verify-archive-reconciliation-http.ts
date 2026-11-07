import {Database} from 'bun:sqlite';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {generateSecretKey,getPublicKey,finalizeEvent,nip19} from 'nostr-tools';

// Spins up only an owned temporary child process, never the managed WApp.
// Copies the supplied SQLite snapshot; all authentication and writes are local
// to that disposable copy. No private key or bearer token is written or logged.
const sourcePath=process.argv[2];if(!sourcePath)throw new Error('Pass an explicit shadow database path');
const temp=mkdtempSync(join(tmpdir(),'archive-graph-http-')),dbPath=join(temp,'shadow.sqlite');
const source=new Database(sourcePath,{readonly:true});writeFileSync(dbPath,source.serialize(),{mode:0o600});source.close();
const key=generateSecretKey(),pubkey=getPublicKey(key),base='http://127.0.0.1:18768';
const child=Bun.spawn([process.execPath,'src/server.ts'],{cwd:process.cwd(),env:{...process.env,PORT:'18768',SNACK_STUDIO_DB_PATH:dbPath,SNACK_STUDIO_DB_BACKUP_DIR:join(temp,'backups'),SNACK_STUDIO_DB_IMPORT_DIR:join(temp,'imports'),SNACK_STUDIO_ARCHIVE_RECONCILIATION:'1',WAPP_OWNER_NPUB:nip19.npubEncode(pubkey)},stdout:'ignore',stderr:'ignore'});
let checks=0;
function assert(value:unknown,message:string){if(!value)throw new Error(message);checks++;}
async function json(path:string,body?:unknown,token?:string){const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,value:await response.json() as any};}
try{
 let ready=false;for(let i=0;i<50;i++){try{ready=(await json('/api/health')).status===200;if(ready)break;}catch{}await Bun.sleep(100);}
 assert(ready,'Temporary server failed to become healthy');
 assert((await json('/api/graph/reconciliation')).status===401,'Reconciliation must require authentication');
 const challenge=await json('/api/auth/challenge',{pubkey});assert(challenge.status===200,'Temporary login challenge failed');
 const event=finalizeEvent({kind:22242,created_at:Math.floor(Date.now()/1000),tags:[],content:challenge.value.content},key);
 const login=await json('/api/auth/verify',{event});assert(login.status===200&&login.value.ok,'Temporary owner login failed');const token=login.value.token;
 const queued=await json('/api/graph/reconciliation',{action:'queue-archive'},token);assert(queued.status===200&&queued.value.jobs.length===21,'Initial archive backfill must use the app-owned queue');
 const queuedAgain=await json('/api/graph/reconciliation',{action:'queue-archive'},token);assert(queuedAgain.value.jobs.length===queued.value.jobs.length,'Queueing the archive twice must not duplicate jobs');
 const contract=await json('/api/graph/contract',undefined,token);assert(contract.value.pipelineVersion==='7'&&contract.value.reconciliation?.pipelineVersion==='2','Reconciliation must be a separate opt-in contract');
 const db=new Database(dbPath,{readonly:true});const episode=db.query('SELECT id,active_transcript_revision_id revision FROM episodes WHERE episode_number=79').get() as {id:string;revision:string};db.close();
 const prepared=await json('/api/graph/reconciliation',{action:'prepare',episodeId:episode.id,revisionId:episode.revision},token);assert(prepared.status===200&&prepared.value.sources.length>0,'Prepare must return grounded archive candidates');
 const stale=await json('/api/graph/reconciliation',{action:'submit',batchId:prepared.value.batchId,snapshot:'stale',proposals:[]},token);assert(stale.status===409,'Stale submissions must fail');
 const submitted=await json('/api/graph/reconciliation',{action:'submit',batchId:prepared.value.batchId,snapshot:prepared.value.snapshot,proposals:[]},token);assert(submitted.status===200&&submitted.value.proposalIds.length===0,'An explicit no-proposal result must be valid');
 const launchBody={operation:'publication-metadata',...contract.value.reconciliation,idempotencyKey:crypto.randomUUID()};
 const request=await json(`/api/episodes/${episode.id}/pipeline-requests`,launchBody,token);
 assert(request.status===201,'Archive pipeline request must be created through Studio');
 assert((await json(`/api/episodes/${episode.id}/pipeline-requests`,launchBody,token)).status===409,'Concurrent duplicate launches must not supersede the signed attempt');
 const trigger=request.value.triggerRequest;
 assert(trigger.url.endsWith('snack-studio-archive-reconciliation.v2'),'Archive trigger must pin its version');
 assert(!JSON.stringify(trigger.body.input).includes('databasePath')&&!JSON.stringify(trigger.body.input).includes('repositoryPath'),'Pipeline inputs must not expose filesystem/database transport');
 const reference=trigger.body.input.localContext.references.find((r:any)=>r.type==='pipeline-context');
 assert((await fetch(reference.url)).status===401,'Archive context must reject unsigned requests');
 const signed=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags:[['u',reference.url],['method','GET']],content:''},key);
 reference.authorization=`Nostr ${Buffer.from(JSON.stringify(signed)).toString('base64')}`;
 const fetchFunction=(await import('../pipelines/functions/snack-studio-fetch-archive-reconciliation.v2.mjs')).default;
 const archive=await fetchFunction(trigger.body.input);assert(archive.batchId===prepared.value.batchId,'Actual pipeline function must fetch the app-owned batch');
 const expired=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000)-600,tags:[['u',reference.url],['method','GET']],content:''},key);
 assert((await fetch(reference.url,{headers:{authorization:`Nostr ${Buffer.from(JSON.stringify(expired)).toString('base64')}`}})).status===401,'Expired delegated signatures must fail');
 const buildResult=(await import('../pipelines/functions/snack-studio-archive-reconciliation-contract.v2.mjs')).default;
 const body=await buildResult({...trigger.body.input,archive,proposalResult:{batchId:archive.batchId,snapshot:archive.snapshot,proposals:[],sourceAssessments:archive.sources.map((s:any)=>({sourceId:s.source.id,rationale:'Synthetic transport fixture; not a model judgment.'}))},critique:{reviews:[]}});
 async function callback(payload:unknown,credential:string){const r=await fetch(base+'/api/pipeline-webhook',{method:'POST',headers:{'content-type':'application/json','x-snack-studio-token':credential},body:JSON.stringify(payload)});return {status:r.status,value:await r.json() as any};}
 assert((await callback(body,'invalid')).status===401,'Webhook must reject an invalid attempt credential');
 assert((await callback({...body,attemptId:'wrong-attempt'},trigger.body.input.webhook.token)).status===409,'Webhook must reject a different attempt');
 const staged=await callback(body,trigger.body.input.webhook.token);
 assert(staged.status===200&&staged.value.reviewStatus==='needs-editorial-review','App-owned webhook must stage suggestions without accepting them');
 assert((await callback(body,trigger.body.input.webhook.token)).value.replay===true,'Webhook replay must be idempotent');
 const unsigned=await json('/api/graph/reconciliation',{action:'finish',batchId:prepared.value.batchId},token);assert(unsigned.status===409,'Completion must require explicit rationale');
 const finished=await json('/api/graph/reconciliation',{action:'finish',batchId:prepared.value.batchId,rationale:'Synthetic HTTP contract check in a disposable database; not an archive semantic review.'},token);assert(finished.status===200,'Explicit completion must succeed');
 const coverage=await json('/api/graph/reconciliation',undefined,token);assert(coverage.value.coverage.find((e:any)=>e.episodeId===episode.id)?.status==='complete','Completed batch must appear in coverage');
 console.log(JSON.stringify({checks,passed:true,scope:'Disposable local HTTP/auth/contract smoke only; no model run and no production changes'}));
}finally{child.kill();await child.exited;rmSync(temp,{recursive:true,force:true});}
