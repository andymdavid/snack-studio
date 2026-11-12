import {agentContributorRoute} from './agent-contributors.ts';
import { createHash } from "node:crypto";
/** Preparation plus guarded Humanizer copy adoption; excludes approvals, publication and deployment. */
export function agentProductionRoute(method: string, path: string): boolean {
  if (agentContributorRoute(method, path)) return true;
  if (method === 'GET') return /^\/api\/(episodes|work|workflow)$/.test(path)
    || /^\/api\/episodes\/[^/]+\/(workspace|candidates|pipeline-requests|thumbnails|curation|workflow|work|public-transcript|publication-preparation|publication-package)$/.test(path)
    || /^\/api\/thumbnail-jobs\/[^/]+$/.test(path);
  return method === 'POST' && (
    path === '/api/graph/copy-edits'
    || /^\/api\/episodes\/[^/]+\/humanizer-revisions$/.test(path)
    || path === '/api/intake'
    || /^\/api\/episodes\/[^/]+\/(pipeline-requests|publication-preparation)$/.test(path)
    || /^\/api\/pipeline-requests\/[^/]+\/retry$/.test(path)
    || /^\/api\/episode-pipeline-runs\/[^/]+\/start$/.test(path)
    || /^\/api\/thumbnail-jobs\/[^/]+\/(generate|start)$/.test(path));
}
export const PRODUCTION_CONTRACTS = {
  snacks: {operation:'transcript-to-snacks',pipelineName:'snack-studio-traditional-humanizer',pipelineVersion:'1',promptSuiteVersion:'v13-humanizer-a58df065',resultSchemaVersion:'1'},
  transcript: {operation:'transcript-normalization',pipelineName:'snack-studio-transcript-cleanup',pipelineVersion:'3',promptSuiteVersion:'v1-public-transcript-cleanup',resultSchemaVersion:'1'},
  themes: {operation:'publication-metadata',pipelineName:'snack-studio-publication-metadata',pipelineVersion:'5',promptSuiteVersion:'v5-catalogued-theme-evidence',resultSchemaVersion:'2'},
  graph: {operation:'publication-metadata',pipelineName:'snack-studio-graph-relationships',pipelineVersion:'9',promptSuiteVersion:'v9-normalized-governed-topics',resultSchemaVersion:'5'},
} as const;
export const V16_PILOT_CONTRACT = {operation:'transcript-to-snacks',pipelineName:'snack-studio-editorial-v16-pilot',pipelineVersion:'16',promptSuiteVersion:'v16-independent-articles',resultSchemaVersion:'1'} as const;
export function allowedProductionContract(body: Record<string, unknown>) {
  // Preserve explicit historical contracts for replay and in-flight requests.
  const historicalSnacks = ['13','14','15'].map(pipelineVersion => ({
    ...PRODUCTION_CONTRACTS.snacks, pipelineName:'snack-studio-transcript-to-snacks',
    pipelineVersion, promptSuiteVersion:'v13-natural-conversational-prose',
  }));
  const contracts = [V16_PILOT_CONTRACT, ...Object.values(PRODUCTION_CONTRACTS), ...historicalSnacks];
  return contracts.some(contract => Object.entries(contract).every(([key,value]) => body[key] === value));
}
export function finalSetFingerprint(candidates: Array<{id:string;reviewDecision:string;approvedPosition:number|null;revision:{id:string}}>) {
  return createHash("sha256").update(JSON.stringify(candidates.filter(c=>c.reviewDecision==='accepted')
    .map(c=>[c.id,c.revision.id,c.approvedPosition]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))))).digest("hex");
}
