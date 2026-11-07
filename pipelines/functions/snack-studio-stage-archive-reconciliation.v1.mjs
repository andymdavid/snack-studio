import { Database } from 'bun:sqlite';
import { stageReconciliationAnalysis } from '/workspace/code/snack-studio/src/graph-reconciliation-stage.ts';
export const name='snackStudio.stageArchiveReconciliationV1';
export const description='Validate complete source assessments and critic recommendations; stage explicit editorial review.';
export const version=1;
export default async function stage(input){
 if(typeof input.databasePath!=='string'||!input.databasePath.startsWith('/'))throw new Error('An explicit absolute Studio databasePath is required');
 const db=new Database(input.databasePath,{create:false});db.exec('PRAGMA foreign_keys=ON');
 try{return stageReconciliationAnalysis(db,input.archive,input.proposalResult,input.critique);}finally{db.close();}
}
