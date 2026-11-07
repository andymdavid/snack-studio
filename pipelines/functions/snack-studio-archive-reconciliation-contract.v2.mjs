export const name='snackStudio.archiveReconciliationContractV2';
export const description='Return proposal analysis and independent critique to Studio without database access or acceptance authority.';
export const version=2;
export default async function result(input){
 if(input.proposalResult?.batchId!==input.archive?.batchId||input.proposalResult?.snapshot!==input.archive?.snapshot||!Array.isArray(input.proposalResult?.proposals)||!Array.isArray(input.proposalResult?.sourceAssessments)||!Array.isArray(input.critique?.reviews))throw new Error('Archive analysis targets a different batch or is incomplete');
 return {requestId:input.requestId,attemptId:input.attemptId,episodeId:input.episodeId,inputRevisionId:input.inputRevisionId,operation:'publication-metadata',pipelineVersion:'2',resultSchemaVersion:'6',batchId:input.archive.batchId,snapshot:input.archive.snapshot,proposalResult:input.proposalResult,critique:input.critique};
}
