import { PRODUCTION_CONTRACTS, finalSetFingerprint } from './agent-production-policy.ts';

type Contract = typeof PRODUCTION_CONTRACTS[keyof typeof PRODUCTION_CONTRACTS];
type Candidate = { id:string;reviewDecision:string;approvedPosition:number|null;revision:{id:string} };
type Pipeline = {id:string;pipelineName:string;pipelineVersion:string|null;idempotencyKey?:string;inputTranscriptRevisionId:string;status:string;runs:Array<{id:string;status:string;triggerPayload:unknown}>};
export type ProductionSnapshot = {
  episode:{id:string;status:string;activeTranscriptRevisionId:string|null};
  candidates:Candidate[]; pipelineRequests:Pipeline[];
  publicTranscript?:{status:string;sourceTranscriptRevisionId:string}|null;
  publicationPreparation?:{jobs:Array<{id:string;assetKind:string;status:string;autopilotRunId?:string|null}>;needsTopicClassification?:unknown[]}|null;
  publicationPackage?:{ready:boolean;blockers:unknown[]}|null;
};
export type ProductionState = {
  version:1;episodeId:string;transcriptRevisionId:string;finalSetFingerprint?:string;
  status:'preparing'|'copy-review'|'asset-review'|'package-review'|'needs-attention';
  reason?:string; pendingImage?:string; errors:Record<string,string>; updatedAt:number;
};
export type ProductionTransport = {
  get(path:string):Promise<any>;
  post(path:string,body:Record<string,unknown>):Promise<any>;
  start(prepared:any,kind:'pipeline'|'thumbnail',id:string,guards:Record<string,string>):Promise<void>;
};
const FAILED=new Set(['failed','timed-out','needs-review','cancelled']);

/** One bounded reconciliation tick. State contains references only, never signing/callback tokens. */
export async function reconcileProduction(
  transport:ProductionTransport, state:ProductionState, save:(state:ProductionState)=>Promise<void>, imageConcurrency=2,
):Promise<ProductionState> {
  if (!Number.isInteger(imageConcurrency) || imageConcurrency<1 || imageConcurrency>4) throw new Error('Image concurrency must be between one and four');
  const ep=encodeURIComponent(state.episodeId);
  const payload=await transport.get(`/episodes/${ep}/workspace?view=publication`);
  const snapshot=(payload.workspace || payload) as ProductionSnapshot;
  const persist=async(status:ProductionState['status'],reason?:string)=>{
    state.status=status;state.reason=reason;state.updatedAt=Date.now();await save(state);return state;
  };
  if (state.pendingImage) return persist('needs-attention',`Image ${state.pendingImage} has an uncertain launch; inspect Studio and Autopilot before clearing it.`);
  if (!snapshot.episode || snapshot.episode.id!==state.episodeId) throw new Error('Workspace episode mismatch');
  if(snapshot.episode.activeTranscriptRevisionId!==state.transcriptRevisionId) return persist('needs-attention','Source transcript changed. Start a new production run after review.');
  const fingerprint=finalSetFingerprint(snapshot.candidates);
  if(state.finalSetFingerprint && state.finalSetFingerprint!==fingerprint) return persist('needs-attention','Approved Snack revisions or order changed. Review dependent work before continuing.');
  const guards={expectedTranscriptRevisionId:state.transcriptRevisionId,expectedFinalSetFingerprint:fingerprint};
  const ensure=async(contract:Contract):Promise<boolean>=>{
    const dependsOnFinalSet=[PRODUCTION_CONTRACTS.themes.pipelineName,PRODUCTION_CONTRACTS.graph.pipelineName].includes(contract.pipelineName as typeof PRODUCTION_CONTRACTS.themes.pipelineName);
    const idempotencyKey=`production-v1:${state.episodeId}:${state.transcriptRevisionId}:${contract.pipelineName}:${contract.pipelineVersion}:${dependsOnFinalSet?fingerprint:'source'}`;
    const existing=snapshot.pipelineRequests.find(p=>p.pipelineName===contract.pipelineName && p.pipelineVersion===contract.pipelineVersion && p.inputTranscriptRevisionId===state.transcriptRevisionId && (!dependsOnFinalSet || p.idempotencyKey===idempotencyKey));
    if(existing){
      if(existing.status==='completed')return true;
      if(FAILED.has(existing.status)){state.errors[existing.id]=`${contract.pipelineName}: ${existing.status}`;return false;}
      const run=existing.runs[0];
      if(run && ['prepared','awaiting-authorization'].includes(run.status) && run.triggerPayload) {
        await transport.start({triggerRequest:run.triggerPayload},'pipeline',run.id,guards);
      }
      return false;
    }
    const prepared=await transport.post(`/episodes/${ep}/pipeline-requests`,{...contract,...guards,idempotencyKey});
    if(prepared.requiresAutopilotAuth)await transport.start(prepared,'pipeline',prepared.runId,guards);
    return prepared.pipelineRequest?.status==='completed';
  };
  state.errors={};
  // Work already reviewed must never trigger a new full generation.
  if(!snapshot.candidates.length && snapshot.episode.status!=='approved') await ensure(PRODUCTION_CONTRACTS.snacks);
  if(!snapshot.publicTranscript || snapshot.publicTranscript.sourceTranscriptRevisionId!==state.transcriptRevisionId)await ensure(PRODUCTION_CONTRACTS.transcript);
  if(snapshot.episode.status!=='approved') return persist(Object.keys(state.errors).length?'needs-attention':snapshot.candidates.length?'copy-review':'preparing','Review copy and approve the final Snack set in Studio.');
  if(!state.finalSetFingerprint){state.finalSetFingerprint=fingerprint;await save(state);}
  const preparation=(await transport.post(`/episodes/${ep}/publication-preparation`,guards)).preparation as NonNullable<ProductionSnapshot['publicationPreparation']>;
  if(preparation.needsTopicClassification?.length)await ensure(PRODUCTION_CONTRACTS.themes);
  await ensure(PRODUCTION_CONTRACTS.graph);
  // Theme colours and contributor references are generation inputs. Re-read on
  // the next tick after classification callbacks, rather than using stale briefs.
  if(preparation.needsTopicClassification?.length) return persist(Object.keys(state.errors).length?'needs-attention':'asset-review','Waiting for theme classification before artwork generation.');
  const jobs=preparation.jobs;
  let active=jobs.filter(j=>['generating','extracting','grounding'].includes(j.status)).length;
  for(const job of jobs){
    // Episode artwork remains a manual upload/review decision in this first release.
    if(job.assetKind!=='snack' || ['approved','needs-review','generated','in-review','generating','extracting','grounding'].includes(job.status)) continue;
    if(!['draft','pending'].includes(job.status)){if(job.status==='failed')state.errors[job.id]='Thumbnail failed; review/retry in Studio.';continue;}
    if(active>=imageConcurrency)break;
    // Persist intent first: a crash after generation/start can never silently generate a second image.
    state.pendingImage=job.id;await save(state);
    try{
      const prepared=await transport.post(`/thumbnail-jobs/${encodeURIComponent(job.id)}/generate`,guards);
      await transport.start(prepared,'thumbnail',job.id,guards);
      delete state.pendingImage;await save(state);active++;
    }catch(error){
      state.errors[job.id]=error instanceof Error?error.message:String(error);
      return persist('needs-attention','Image launch needs reconciliation; successful jobs remain intact.');
    }
  }
  const pkg=(await transport.get(`/episodes/${ep}/publication-package`)).package;
  if(Object.keys(state.errors).length)return persist('needs-attention','Some jobs need review; successful work has been retained.');
  return persist(pkg?.ready?'package-review':'asset-review',pkg?.ready?'Prepared package is ready for human release review. No publication was requested.':'Review artwork, public transcript, graph and newsletter choices in Studio.');
}
