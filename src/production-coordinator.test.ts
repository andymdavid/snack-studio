import { expect, test } from 'bun:test';
import { agentProductionRoute, finalSetFingerprint, PRODUCTION_CONTRACTS, allowedProductionContract } from './agent-production-policy.ts';
import { reconcileProduction, type ProductionState, type ProductionSnapshot, type ProductionTransport } from './production-coordinator.ts';

function fixture(approved=false) {
  const snapshot:ProductionSnapshot={episode:{id:'ep',status:approved?'approved':'review',activeTranscriptRevisionId:'source'},candidates:[],pipelineRequests:[],publicTranscript:{status:'proposed',sourceTranscriptRevisionId:'source'}};
  const state:ProductionState={version:1,episodeId:'ep',transcriptRevisionId:'source',status:'preparing',errors:{},updatedAt:0};
  const posts:Array<{path:string;body:Record<string,unknown>}>=[];
  const starts:string[]=[];
  const saved:ProductionState[]=[];
  const preparation={jobs:[] as Array<{id:string;assetKind:string;status:string}>,needsTopicClassification:[] as string[]};
  const transport:ProductionTransport={
    async get(path){return path.includes('workspace')?{workspace:snapshot}:{package:{ready:false}};},
    async post(path,body){posts.push({path,body});return path.endsWith('publication-preparation')?{preparation}:{runId:'run',requiresAutopilotAuth:true};},
    async start(_prepared,_kind,id){starts.push(id);},
  };
  const tick=()=>reconcileProduction(transport,state,async s=>{saved.push(structuredClone(s));},2);
  return {snapshot,state,posts,starts,saved,preparation,transport,tick};
}

test('preparation access excludes approvals, edits, publication and deployment',()=>{
  for(const path of ['/api/episodes/ep/approve','/api/candidates/c','/api/episodes/ep/git-publication','/api/episodes/ep/git-deployment','/api/access']) expect(agentProductionRoute('POST',path)).toBe(false);
  expect(agentProductionRoute('POST','/api/episodes/ep/pipeline-requests')).toBe(true);
  expect(agentProductionRoute('GET','/api/episodes/ep/workspace')).toBe(true);
  expect(agentProductionRoute('DELETE','/api/episodes/ep')).toBe(false);
  expect(allowedProductionContract({...PRODUCTION_CONTRACTS.snacks,pipelineVersion:'99'})).toBe(false);
});
test('fingerprint tracks accepted revision and order but ignores rejected copy',()=>{
  const c={id:'c',reviewDecision:'accepted',approvedPosition:1,revision:{id:'v1'}};
  expect(finalSetFingerprint([c])).not.toBe(finalSetFingerprint([{...c,revision:{id:'v2'}}]));
  expect(finalSetFingerprint([c])).not.toBe(finalSetFingerprint([{...c,approvedPosition:2}]));
  expect(finalSetFingerprint([c])).toBe(finalSetFingerprint([c,{...c,id:'rejected',reviewDecision:'rejected'}]));
});
test('changed source stops all writes',async()=>{
  const f=fixture();f.snapshot.episode.activeTranscriptRevisionId='changed';
  expect((await f.tick()).status).toBe('needs-attention');expect(f.posts).toHaveLength(0);
});
test('changed approved copy stops dependent work',async()=>{
  const f=fixture(true);f.state.finalSetFingerprint='old';
  expect((await f.tick()).status).toBe('needs-attention');expect(f.posts).toHaveLength(0);
});
test('uncertain image launch cannot create a duplicate after restart',async()=>{
  const f=fixture(true);f.state.pendingImage='uncertain';
  expect((await f.tick()).status).toBe('needs-attention');expect(f.posts).toHaveLength(0);expect(f.starts).toHaveLength(0);
});
test('existing copy pauses for human review without generating another set',async()=>{
  const f=fixture();f.snapshot.candidates=[{id:'c',reviewDecision:'accepted',approvedPosition:1,revision:{id:'v'}}];
  expect((await f.tick()).status).toBe('copy-review');expect(f.posts).toHaveLength(0);
});
test('queued generation is reconciled without another trigger',async()=>{
  const f=fixture();f.snapshot.pipelineRequests=[{id:'p',...PRODUCTION_CONTRACTS.snacks,inputTranscriptRevisionId:'source',status:'running',runs:[]}];
  await f.tick();expect(f.posts).toHaveLength(0);expect(f.starts).toHaveLength(0);
});
test('failed generation surfaces for review without automatic retry',async()=>{
  const f=fixture();f.snapshot.pipelineRequests=[{id:'p',...PRODUCTION_CONTRACTS.snacks,inputTranscriptRevisionId:'source',status:'failed',runs:[]}];
  expect((await f.tick()).status).toBe('needs-attention');expect(f.state.errors.p).toContain('failed');expect(f.posts).toHaveLength(0);
});
test('theme classification blocks image launches until fresh briefs exist',async()=>{
  const f=fixture(true);f.preparation.needsTopicClassification=['c'];f.preparation.jobs=[{id:'img',assetKind:'snack',status:'draft'}];
  await f.tick();expect(f.posts.some(p=>p.body.pipelineName===PRODUCTION_CONTRACTS.themes.pipelineName)).toBe(true);
  expect(f.posts.some(p=>p.path.endsWith('/generate'))).toBe(false);
});
test('artwork queue fills two slots and persists intent before launch',async()=>{
  const f=fixture(true);f.preparation.jobs=Array.from({length:5},(_,i)=>({id:`img${i}`,assetKind:'snack',status:'draft'}));
  await f.tick();expect(f.posts.filter(p=>p.path.endsWith('/generate'))).toHaveLength(2);
  expect(f.saved.some(s=>s.pendingImage==='img0')).toBe(true);expect(f.state.pendingImage).toBeUndefined();
});
test('failed artwork stays failed while another pending image can start',async()=>{
  const f=fixture(true);f.preparation.jobs=[{id:'bad',assetKind:'snack',status:'failed'},{id:'good',assetKind:'snack',status:'draft'}];
  expect((await f.tick()).status).toBe('needs-attention');expect(f.state.errors.bad).toBeDefined();expect(f.starts).toContain('good');expect(f.starts).not.toContain('bad');
});
test('old graph request cannot satisfy a changed final set',async()=>{
  const f=fixture(true);f.snapshot.pipelineRequests=[{id:'old',...PRODUCTION_CONTRACTS.graph,idempotencyKey:'old-set',inputTranscriptRevisionId:'source',status:'completed',runs:[]}];
  await f.tick();expect(f.posts.some(p=>p.body.pipelineName===PRODUCTION_CONTRACTS.graph.pipelineName && p.body.idempotencyKey!=='old-set')).toBe(true);
});

test('new Snack preparation selects v13 plus Humanizer and preserves historical contracts',()=>{
  expect(PRODUCTION_CONTRACTS.snacks).toMatchObject({pipelineName:'snack-studio-traditional-humanizer',pipelineVersion:'1',promptSuiteVersion:'v13-humanizer-a58df065'});
  for(const pipelineVersion of ['13','14','15']) expect(allowedProductionContract({...PRODUCTION_CONTRACTS.snacks,pipelineName:'snack-studio-transcript-to-snacks',pipelineVersion,promptSuiteVersion:'v13-natural-conversational-prose'})).toBe(true);
  expect(allowedProductionContract({...PRODUCTION_CONTRACTS.snacks,pipelineVersion:'99'})).toBe(false);
  expect(allowedProductionContract({...PRODUCTION_CONTRACTS.snacks,promptSuiteVersion:'v13-natural-conversational-prose'})).toBe(false);
});
