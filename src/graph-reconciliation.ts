import type { Database } from 'bun:sqlite';
import { registerObservation, acceptedReconciliation, createReconciliationBatch, type ReconciliationContext, type Observation } from './graph-reconciliation-store.ts';

export function loadReconciliationContext(db: Database): ReconciliationContext {
  const nodes = db.query(`SELECT n.*,t.transcript_text FROM knowledge_nodes n JOIN episodes e ON e.id=n.episode_id
    JOIN transcript_revisions t ON t.id=n.source_transcript_revision_id
    WHERE n.review_state='accepted' AND n.source_transcript_revision_id=e.active_transcript_revision_id ORDER BY n.id`).all() as Array<{id:string;episode_id:string;source_transcript_revision_id:string;kind:string;title:string;summary:string;transcript_text:string}>;
  const evidenceQuery = db.query('SELECT * FROM knowledge_evidence WHERE knowledge_node_id=?1 ORDER BY id');
  const observations: Observation[] = [];
  for (const node of nodes) {
    const evidence = (evidenceQuery.all(node.id) as Array<{id:string;excerpt:string;speaker:string|null;transcript_start:number|null;transcript_end:number|null}>).flatMap(e => {
      let start = e.transcript_start, end = e.transcript_end;
      if (start == null || end == null || node.transcript_text.slice(start,end) !== e.excerpt) {
        // Recover only an unambiguous byte-exact excerpt. Normalized/fuzzy
        // matches are not strong enough to ground a new public interpretation.
        start = node.transcript_text.indexOf(e.excerpt);
        if (!e.excerpt.trim() || start < 0 || node.transcript_text.indexOf(e.excerpt,start+1) !== -1) return [];
        end = start+e.excerpt.length;
      }
      return [{id:e.id,excerpt:e.excerpt,speaker:e.speaker,start,end}];
    });
    if (!evidence.length) continue;
    observations.push(registerObservation(db,{nodeId:node.id,episodeId:node.episode_id,revisionId:node.source_transcript_revision_id,kind:node.kind,title:node.title,summary:node.summary,evidence},node.transcript_text));
  }
  const aliases = db.query('SELECT concept_id,alias FROM graph_concept_aliases ORDER BY alias').all() as Array<{concept_id:string;alias:string}>;
  const concepts = (db.query("SELECT * FROM canonical_concepts WHERE review_state='accepted' ORDER BY id").all() as Array<{id:string;title:string;summary:string;updated_at:number}>).map(c=>({id:c.id,title:c.title,summary:c.summary,updatedAt:c.updated_at,aliases:aliases.filter(a=>a.concept_id===c.id).map(a=>a.alias)}));
  return {observations,concepts};
}

const STOP_WORDS = new Set('a an and are as at be been but by can could do for from has have how i if in into is it its may more not of on or our that the their these they this to use using was we what when which will with would you your'.split(' '));
export function retrievalTokens(text: string) {
  const singular=(token:string)=>token.length<5?token:token.endsWith('ies')?`${token.slice(0,-3)}y`:/(sses|shes|ches|xes|zes)$/.test(token)?token.slice(0,-2):token.endsWith('s')&&!/(ss|us|is)$/.test(token)?token.slice(0,-1):token;
  return [...new Set((text.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu)||[]).filter(t=>!STOP_WORDS.has(t)).map(singular))];
}

// Baseline retrieval is lexical and alias-aware. Scores are retrieval evidence,
// never calibrated probabilities or a basis for automatic acceptance.
export function retrieveArchiveCandidates(context: ReconciliationContext, source: Observation, limit = 8) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Candidate limit must be 1–20');
  const documents = context.observations.filter(o=>o.episodeId !== source.episodeId);
  const queryTokens = retrievalTokens(`${source.title} ${source.summary}`);
  const terms = new Map(documents.map(o=>[o.id,new Set(retrievalTokens(`${o.title} ${o.summary}`))]));
  const frequency = new Map<string,number>(); for (const tokens of terms.values()) for (const token of tokens) frequency.set(token,(frequency.get(token)||0)+1);
  const scored = documents.map(observation=>{
    const tokens=terms.get(observation.id)!, matched=queryTokens.filter(t=>tokens.has(t));
    const titleTerms=new Set(retrievalTokens(source.title)),targetTitle=new Set(retrievalTokens(observation.title));
    const score=matched.reduce((sum,t)=>sum+Math.log(1+(documents.length+1)/((frequency.get(t)||0)+1))*(titleTerms.has(t)&&targetTitle.has(t)?3:1),0)/Math.sqrt(Math.max(1,tokens.size));
    return {observation,score,matchedTerms:matched};
  }).filter(c=>c.matchedTerms.length >= 2).sort((a,b)=>b.score-a.score||a.observation.id.localeCompare(b.observation.id)).slice(0,limit);
  const sourceText=` ${retrievalTokens(`${source.title} ${source.summary}`).join(' ')} `;
  const concepts=context.concepts.map(concept=>({concept,matchedAliases:[concept.title,...concept.aliases].filter(alias=>{
    const words=retrievalTokens(alias);return words.length>0&&words.every(t=>sourceText.includes(` ${t} `));
  })})).filter(c=>c.matchedAliases.length).slice(0,limit);
  return {sourceId:source.id,candidates:scored,concepts,retrievalVersion:'lexical-alias-v1',limitation:'Candidate discovery only; semantic paraphrases without shared words can be missed.'};
}

export function prepareEpisodeReconciliation(db: Database, episodeId: string, revisionId: string) {
  const context=loadReconciliationContext(db),batch=createReconciliationBatch(db,episodeId,revisionId,context);
  return {contractVersion:'1',batchId:batch.id,snapshot:batch.snapshot,episodeId,revisionId,
    sources:batch.sources.map(source=>({source,...retrieveArchiveCandidates(context,source),existingDecisions:acceptedReconciliation(db,context).filter(p=>p.sourceId===source.id||p.targetId===source.id)})),
    instructions:'Propose concept assignments and cross-episode reasoning separately. Inspect evidence at both ends. Same topic is not equivalent meaning. Abstain when unsupported. Return batchId, snapshot and proposals; do not accept your own proposals.'};
}

export function reconciliationPublicData(db: Database, context: ReconciliationContext, publicNodeIds: Set<string>) {
  const observations=new Map(context.observations.map(o=>[o.id,o])), decisions=acceptedReconciliation(db,context).filter(p=>publicNodeIds.has(observations.get(p.sourceId)!.nodeId)&&(!p.targetId||publicNodeIds.has(observations.get(p.targetId)!.nodeId)));
  const groups=new Map<string,{id:string;title:string;summary:string;reviewState:string;reviewer:string;reviewMethod:string;mentions:string[];episodes:string[]}>();
  for(const proposal of decisions.filter(p=>p.kind==='concept')) {
    const concept=proposal.concept!,source=observations.get(proposal.sourceId)!;
    const group=groups.get(concept.id)||{...concept,reviewState:'accepted',reviewer:proposal.reviewer,reviewMethod:proposal.reviewMethod,mentions:[],episodes:[]};
    group.mentions=[...new Set([...group.mentions,source.nodeId])];group.episodes=[...new Set([...group.episodes,source.episodeId])];groups.set(concept.id,group);
  }
  const relationships=[...new Map(decisions.filter(p=>p.kind==='relationship').map(p=>{
    const source=observations.get(p.sourceId)!,target=observations.get(p.targetId!)!;
    return [`${source.nodeId}:${target.nodeId}:${p.relationshipType}`,{id:p.id,sourceId:source.nodeId,targetId:target.nodeId,relationshipType:p.relationshipType,explanation:p.explanation,reviewState:'accepted',reviewer:p.reviewer,reviewMethod:p.reviewMethod,reviewedAt:p.reviewedAt,
      sources:[source,target].map(o=>({nodeId:o.nodeId,transcriptRevisionId:o.revisionId,evidenceIds:p.evidence.find(e=>e.observationId===o.id)!.evidenceIds}))}] as const;
  })).values()];
  return {conceptRegistry:{version:1,concepts:[...groups.values()]},relationshipRegistry:{version:1,scope:'Reviewed archive reconciliation',relationships}};
}

export function reconciliationCoverage(db: Database, context: ReconciliationContext) {
  const eligible=db.query(`SELECT e.id,e.active_transcript_revision_id revision,(SELECT COUNT(*) FROM knowledge_nodes n WHERE n.episode_id=e.id AND n.review_state='accepted' AND n.source_transcript_revision_id=e.active_transcript_revision_id) observation_count FROM episodes e WHERE EXISTS(SELECT 1 FROM knowledge_nodes n WHERE n.episode_id=e.id AND n.review_state='accepted' AND n.source_transcript_revision_id=e.active_transcript_revision_id) ORDER BY e.id`).all() as Array<{id:string;revision:string;observation_count:number}>;
  const batches=db.query("SELECT * FROM graph_reconciliation_batches WHERE scope='episode' ORDER BY updated_at DESC,id").all() as Array<{id:string;episode_id:string;revision_id:string;status:string;context_json:string}>;
  return eligible.map(e=>{
    const grounded=context.observations.filter(o=>o.episodeId===e.id&&o.revisionId===e.revision);
    const batch=batches.find(b=>b.episode_id===e.id&&b.revision_id===e.revision);
    const currentIds=new Set(context.observations.map(o=>o.id));
    const stale=batch && (JSON.parse(batch.context_json) as ReconciliationContext).observations.some(o=>!currentIds.has(o.id));
    return {episodeId:e.id,revisionId:e.revision,eligibleObservations:e.observation_count,groundedObservations:grounded.length,blockedObservations:e.observation_count-grounded.length,batchId:batch?.id||null,status:!grounded.length?'blocked-evidence':grounded.length<e.observation_count?'partial-evidence':stale?'stale':batch?.status||'not-started'};
  });
}
