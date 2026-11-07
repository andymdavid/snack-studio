import { Database } from 'bun:sqlite';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
export const name='snackStudio.stageArchiveReconciliationV1';
export const description='Validate complete source assessments and critic recommendations; stage explicit editorial review.';
export const version=1;
export default async function stage(input){
 const {stageReconciliationAnalysis}=await import(pathToFileURL(resolve(input.repositoryPath||'/workspace/code/snack-studio','src/graph-reconciliation-stage.ts')).href);
 if(typeof input.databasePath!=='string'||!input.databasePath.startsWith('/'))throw new Error('An explicit absolute Studio databasePath is required');
 const db=new Database(input.databasePath,{create:false});db.exec('PRAGMA foreign_keys=ON');
 try{return stageReconciliationAnalysis(db,input.archive,input.proposalResult,input.critique);}finally{db.close();}
}
