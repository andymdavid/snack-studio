import type { Database } from 'bun:sqlite';
import type { SuccessfulKnowledgeResult } from './knowledge-result-input.ts';
import { digest } from './graph-reconciliation-store.ts';

// Preserve legacy node and evidence IDs for byte-identical observations on the
// same immutable transcript. Model-local keys and response ordering are not IDs.
// Changed content gets a new identity and never overwrites a reviewed assertion.
export function planKnowledgeIdentities(db:Database,episodeId:string,revisionId:string,nodes:SuccessfulKnowledgeResult['nodes']){
 const fingerprint=(node:{kind:string;title:string;summary:string;evidence:Array<{excerpt:string;speaker:string|null}>})=>digest([node.kind,node.title,node.summary,node.evidence.map(e=>[e.excerpt,e.speaker]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
 const existing=db.query('SELECT id,kind,title,summary FROM knowledge_nodes WHERE episode_id=?1 AND source_transcript_revision_id=?2').all(episodeId,revisionId) as Array<{id:string;kind:string;title:string;summary:string}>;
 const evidenceQuery=db.query('SELECT excerpt,speaker FROM knowledge_evidence WHERE knowledge_node_id=?1');
 const matches=new Map(existing.map(n=>[fingerprint({...n,evidence:evidenceQuery.all(n.id) as Array<{excerpt:string;speaker:string|null}>}),n.id]));
 const byKey=new Map<string,string>(),preserved=new Set<string>();
 for(const node of nodes){const match=matches.get(fingerprint(node));const id=match||`idea-source-${digest([episodeId,revisionId,fingerprint(node)]).slice(0,32)}`;byKey.set(node.key,id);if(match)preserved.add(match);}
 if(new Set(byKey.values()).size!==nodes.length)throw new Error('Duplicate extracted observations; consolidate before applying');
 return {byKey,preserved};
}
