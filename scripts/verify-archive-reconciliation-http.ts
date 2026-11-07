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
 const contract=await json('/api/graph/contract',undefined,token);assert(contract.value.pipelineVersion==='10'&&contract.value.promptSuiteVersion==='v10-archive-reconciliation','Opt-in graph contract must be v10');
 const db=new Database(dbPath,{readonly:true});const episode=db.query('SELECT id,active_transcript_revision_id revision FROM episodes WHERE episode_number=79').get() as {id:string;revision:string};db.close();
 const prepared=await json('/api/graph/reconciliation',{action:'prepare',episodeId:episode.id,revisionId:episode.revision},token);assert(prepared.status===200&&prepared.value.sources.length>0,'Prepare must return grounded archive candidates');
 const stale=await json('/api/graph/reconciliation',{action:'submit',batchId:prepared.value.batchId,snapshot:'stale',proposals:[]},token);assert(stale.status===409,'Stale submissions must fail');
 const submitted=await json('/api/graph/reconciliation',{action:'submit',batchId:prepared.value.batchId,snapshot:prepared.value.snapshot,proposals:[]},token);assert(submitted.status===200&&submitted.value.proposalIds.length===0,'An explicit no-proposal result must be valid');
 const unsigned=await json('/api/graph/reconciliation',{action:'finish',batchId:prepared.value.batchId},token);assert(unsigned.status===409,'Completion must require explicit rationale');
 const finished=await json('/api/graph/reconciliation',{action:'finish',batchId:prepared.value.batchId,rationale:'Synthetic HTTP contract check in a disposable database; not an archive semantic review.'},token);assert(finished.status===200,'Explicit completion must succeed');
 const coverage=await json('/api/graph/reconciliation',undefined,token);assert(coverage.value.coverage.find((e:any)=>e.episodeId===episode.id)?.status==='complete','Completed batch must appear in coverage');
 console.log(JSON.stringify({checks,passed:true,scope:'Disposable local HTTP/auth/contract smoke only; no model run and no production changes'}));
}finally{child.kill();await child.exited;rmSync(temp,{recursive:true,force:true});}
