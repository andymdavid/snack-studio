import type { Database } from 'bun:sqlite';
import { digest, createReconciliationBatch, submitReconciliationProposals, reviewReconciliationProposal, finishReconciliationBatch, type ReconciliationProposal } from './graph-reconciliation-store.ts';
import { loadReconciliationContext } from './graph-reconciliation.ts';

type PilotConcept={id:string;title:string;summary:string;reviewState:string;reviewer:string;reviewMethod:string;mentions:string[]};
type PilotRelationship={id:string;sourceId:string;targetId:string;relationshipType:ReconciliationProposal['relationshipType'];explanation:string;reviewState:string;reviewer:string;reviewMethod:string;sources:Array<{nodeId:string;transcriptRevisionId:string;evidenceIds:string[]}>};

// Explicit import of already reviewed pilot decisions, not automatic semantic
// matching. The full operation is transactional and safe to replay.
export function importReviewedGraphPilot(db:Database,concepts:PilotConcept[],relationships:PilotRelationship[]){
 db.exec('CREATE TABLE IF NOT EXISTS graph_reconciliation_imports(id TEXT PRIMARY KEY,report_json TEXT NOT NULL,created_at INTEGER NOT NULL)');
 const importId=digest([concepts,relationships]);
 const existing=db.query('SELECT report_json FROM graph_reconciliation_imports WHERE id=?1').get(importId) as {report_json:string}|null;
 if(existing)return {...JSON.parse(existing.report_json),replay:true};
 return db.transaction(()=>{
  const initial=loadReconciliationContext(db),byNode=new Map(initial.observations.map(o=>[o.nodeId,o]));
  const entries:Array<{proposal:ReconciliationProposal;reviewer:string;method:string}>=[];
  for(const concept of concepts){
   if(concept.reviewState!=='accepted'||!concept.reviewer||!concept.reviewMethod)throw new Error('Pilot concept lacks explicit review');
   for(const nodeId of concept.mentions){const source=byNode.get(nodeId);if(!source)throw new Error(`Pilot source needs evidence repair: ${nodeId}`);
    entries.push({proposal:{key:`pilot-concept-${concept.id}-${nodeId}`,kind:'concept',sourceId:source.id,concept:{id:concept.id,title:concept.title,summary:concept.summary,aliases:[]},explanation:concept.summary,evidence:[{observationId:source.id,evidenceIds:source.evidence.map(e=>e.id)}]},reviewer:concept.reviewer,method:concept.reviewMethod});
   }
  }
  for(const relationship of relationships){
   if(relationship.reviewState!=='accepted'||!relationship.reviewer||!relationship.reviewMethod)throw new Error('Pilot relationship lacks explicit review');
   const source=byNode.get(relationship.sourceId),target=byNode.get(relationship.targetId);if(!source||!target)throw new Error('Pilot relationship source unavailable');
   const evidence=[source,target].map(o=>{const ref=relationship.sources.find(s=>s.nodeId===o.nodeId);if(!ref||ref.transcriptRevisionId!==o.revisionId||ref.evidenceIds.some(id=>!o.evidence.some(e=>e.id===id)))throw new Error('Pilot source changed; re-review required');return {observationId:o.id,evidenceIds:ref.evidenceIds};});
   entries.push({proposal:{key:`pilot-relationship-${relationship.id}`,kind:'relationship',sourceId:source.id,targetId:target.id,relationshipType:relationship.relationshipType,explanation:relationship.explanation,evidence},reviewer:relationship.reviewer,method:relationship.reviewMethod});
  }
  const episodes=[...new Set(entries.map(e=>initial.observations.find(o=>o.id===e.proposal.sourceId)!.episodeId))];
  for(const episodeId of episodes){
   const context=loadReconciliationContext(db),sources=context.observations.filter(o=>o.episodeId===episodeId),batch=createReconciliationBatch(db,episodeId,sources[0]!.revisionId,context,'pilot-import');
   const subset=entries.filter(e=>sources.some(o=>o.id===e.proposal.sourceId)),ids=submitReconciliationProposals(db,batch.id,subset.map(e=>e.proposal));
   subset.forEach((e,i)=>reviewReconciliationProposal(db,ids[i]!,'accepted',e.reviewer,'Imported existing reviewed pilot; exact sources verified.',context,e.method));
   finishReconciliationBatch(db,batch.id,context);
  }
  const report={conceptMentions:entries.filter(e=>e.proposal.kind==='concept').length,relationships:relationships.length,episodes:episodes.length,replay:false};
  db.query('INSERT INTO graph_reconciliation_imports VALUES(?1,?2,?3)').run(importId,JSON.stringify(report),Date.now());return report;
 })();
}
