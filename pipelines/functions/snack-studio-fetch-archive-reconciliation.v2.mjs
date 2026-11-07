export const name='snackStudio.fetchArchiveReconciliationV2';
export const description='Fetch app-owned archive context through the exact delegated NIP-98 reference.';
export const version=2;
export default async function fetchArchive(input){
 const reference=input.localContext?.references?.find(row=>row.type==='pipeline-context');
 if(!reference?.url||!reference.authorization?.startsWith('Nostr '))throw new Error('Signed Studio context reference required');
 const response=await fetch(reference.url,{headers:{authorization:reference.authorization,accept:'application/json'},redirect:'error'});
 if(!response.ok)throw new Error(`Studio archive context request failed (${response.status})`);
 const context=await response.json();
 if(context.requestId!==input.requestId||context.attemptId!==input.attemptId||context.episodeId!==input.episodeId||context.inputRevisionId!==input.inputRevisionId||!context.archive?.batchId||!context.archive?.snapshot||!Array.isArray(context.archive.sources))throw new Error('Studio archive context provenance mismatch');
 return context.archive;
}
