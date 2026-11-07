import { Database } from 'bun:sqlite';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
export const name='snackStudio.prepareArchiveReconciliationV1';
export const description='Prepare revision-pinned archive candidates in the explicitly configured Studio database.';
export const version=1;
export default async function prepare(input){
 const {prepareEpisodeReconciliation}=await import(pathToFileURL(resolve(input.repositoryPath||'/workspace/code/snack-studio','src/graph-reconciliation.ts')).href);
 if(typeof input.databasePath!=='string'||!input.databasePath.startsWith('/'))throw new Error('An explicit absolute Studio databasePath is required');
 const db=new Database(input.databasePath,{create:false});db.exec('PRAGMA foreign_keys=ON');
 try{return prepareEpisodeReconciliation(db,String(input.episodeId||''),String(input.revisionId||''));}finally{db.close();}
}
