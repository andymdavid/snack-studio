import { Database } from 'bun:sqlite';
import { prepareEpisodeReconciliation } from '/workspace/code/snack-studio/src/graph-reconciliation.ts';
export const name='snackStudio.prepareArchiveReconciliationV1';
export const description='Prepare revision-pinned archive candidates in the explicitly configured Studio database.';
export const version=1;
export default async function prepare(input){
 if(typeof input.databasePath!=='string'||!input.databasePath.startsWith('/'))throw new Error('An explicit absolute Studio databasePath is required');
 const db=new Database(input.databasePath,{create:false});db.exec('PRAGMA foreign_keys=ON');
 try{return prepareEpisodeReconciliation(db,String(input.episodeId||''),String(input.revisionId||''));}finally{db.close();}
}
