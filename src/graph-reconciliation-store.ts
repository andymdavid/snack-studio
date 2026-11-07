import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';

export const RECONCILIATION_VERSION = '1';
export const REASONING_TYPES = ['supports', 'develops', 'contradicts', 'exemplifies', 'enables', 'caused-by', 'related-to', 'extends', 'parallels', 'complements'] as const;
export type ReasoningType = typeof REASONING_TYPES[number];
export type SourceObservation = {
  nodeId: string; episodeId: string; revisionId: string; kind: string; title: string; summary: string;
  evidence: Array<{ id: string; excerpt: string; speaker: string | null; start: number; end: number }>;
};
export type Observation = SourceObservation & { id: string; identityId: string; fingerprint: string };
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalized = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim();

// These tables deliberately retain snapshots independently of replaceable
// knowledge_nodes. Re-extraction must never cascade away editorial history.
export function installReconciliationSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_observation_identities (
      id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      UNIQUE(episode_id,fingerprint));
    CREATE TABLE IF NOT EXISTS graph_observation_versions (
      id TEXT PRIMARY KEY, identity_id TEXT NOT NULL REFERENCES graph_observation_identities(id),
      node_id TEXT NOT NULL, episode_id TEXT NOT NULL, revision_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, source_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(node_id,revision_id,fingerprint));
    CREATE INDEX IF NOT EXISTS graph_observation_source ON graph_observation_versions(episode_id,revision_id);
    CREATE TABLE IF NOT EXISTS graph_reconciliation_batches (
      id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, revision_id TEXT NOT NULL,
      contract_version TEXT NOT NULL, snapshot TEXT NOT NULL, context_json TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'episode' CHECK(scope IN ('episode','pilot-import')),
      status TEXT NOT NULL CHECK(status IN ('pending','review','complete','stale')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS graph_reconciliation_proposals (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES graph_reconciliation_batches(id),
      proposal_key TEXT NOT NULL, proposal_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('proposed','accepted','rejected','stale')),
      UNIQUE(batch_id,proposal_key));
    CREATE TABLE IF NOT EXISTS graph_reconciliation_decisions (
      id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES graph_reconciliation_proposals(id),
      decision TEXT NOT NULL CHECK(decision IN ('accepted','rejected','stale')),
      reviewer TEXT NOT NULL, method TEXT NOT NULL, rationale TEXT NOT NULL,
      created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS graph_concept_aliases (
      concept_id TEXT NOT NULL REFERENCES canonical_concepts(id), alias TEXT NOT NULL,
      PRIMARY KEY(concept_id,alias));
    CREATE TABLE IF NOT EXISTS graph_identity_redirects (
      source_id TEXT PRIMARY KEY, target_id TEXT NOT NULL, reviewer TEXT NOT NULL,
      rationale TEXT NOT NULL, created_at INTEGER NOT NULL, CHECK(source_id<>target_id));
    CREATE TABLE IF NOT EXISTS graph_reconciliation_jobs (
      episode_id TEXT NOT NULL, revision_id TEXT NOT NULL, contract_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','review','complete','failed')),
      batch_id TEXT, error TEXT, updated_at INTEGER NOT NULL,
      PRIMARY KEY(episode_id,revision_id,contract_version));
  `);
  const columns=db.query('PRAGMA table_info(graph_reconciliation_batches)').all() as Array<{name:string}>;
  if(!columns.some(c=>c.name==='scope'))db.exec("ALTER TABLE graph_reconciliation_batches ADD COLUMN scope TEXT NOT NULL DEFAULT 'episode'");
}

export function registerObservation(db: Database, source: SourceObservation, transcript: string): Observation {
  if (!source.nodeId || !source.episodeId || !source.revisionId || !['concept','claim','example','question'].includes(source.kind)
    || !source.title.trim() || !source.summary.trim() || !source.evidence.length) throw new Error('Incomplete source observation');
  for (const evidence of source.evidence) {
    if (!evidence.id || !evidence.excerpt.trim() || !Number.isInteger(evidence.start) || !Number.isInteger(evidence.end)
      || evidence.start < 0 || evidence.end <= evidence.start || transcript.slice(evidence.start, evidence.end) !== evidence.excerpt) throw new Error('Evidence must pin an exact source span');
  }
  const fingerprint = digest([source.episodeId, source.kind, normalized(source.title), normalized(source.summary),
    source.evidence.map(e => [normalized(e.excerpt), e.speaker && normalized(e.speaker)]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
  const identityId = `idea-${digest([source.episodeId,fingerprint]).slice(0,32)}`;
  const id = `observation-${digest([source.nodeId,source.revisionId,fingerprint]).slice(0,32)}`;
  const observation = { ...source, id, identityId, fingerprint };
  const existing = db.query('SELECT source_json FROM graph_observation_versions WHERE id=?1').get(id) as {source_json:string} | null;
  // Same node/revision with changed evidence IDs must not silently mutate a
  // snapshot referenced by a decision. Revision IDs are immutable contracts.
  if (existing && existing.source_json !== JSON.stringify(observation)) throw new Error('Observation snapshot changed under immutable revision');
  db.transaction(() => {
    db.query('INSERT OR IGNORE INTO graph_observation_identities VALUES(?1,?2,?3)').run(identityId,source.episodeId,fingerprint);
    db.query('INSERT OR IGNORE INTO graph_observation_versions VALUES(?1,?2,?3,?4,?5,?6,?7,?8)').run(id,identityId,source.nodeId,source.episodeId,source.revisionId,fingerprint,JSON.stringify(observation),Date.now());
  })();
  return observation;
}

export function observationById(db: Database, id: string): Observation {
  const row = db.query('SELECT source_json FROM graph_observation_versions WHERE id=?1').get(id) as {source_json:string} | null;
  if (!row) throw new Error(`Unknown observation ${id}`);
  return JSON.parse(row.source_json);
}

function assertCurrentObservation(db:Database,observation:Observation){
  const node=db.query(`SELECT n.kind,n.title,n.summary,t.transcript_text FROM knowledge_nodes n JOIN episodes e ON e.id=n.episode_id
    JOIN transcript_revisions t ON t.id=n.source_transcript_revision_id WHERE n.id=?1 AND n.episode_id=?2
    AND n.source_transcript_revision_id=?3 AND e.active_transcript_revision_id=?3 AND n.review_state='accepted'`).get(observation.nodeId,observation.episodeId,observation.revisionId) as {kind:string;title:string;summary:string;transcript_text:string}|null;
  if(!node||node.kind!==observation.kind||node.title!==observation.title||node.summary!==observation.summary)throw new Error('Source observation changed; re-review required');
  for(const ref of observation.evidence){
    const evidence=db.query('SELECT excerpt,speaker FROM knowledge_evidence WHERE id=?1 AND knowledge_node_id=?2').get(ref.id,observation.nodeId) as {excerpt:string;speaker:string|null}|null;
    if(!evidence||evidence.excerpt!==ref.excerpt||evidence.speaker!==ref.speaker||node.transcript_text.slice(ref.start,ref.end)!==ref.excerpt)throw new Error('Source evidence changed; re-review required');
  }
}

export type ReconciliationProposal = {
  key: string; kind: 'concept' | 'relationship'; sourceId: string;
  targetId?: string; concept?: { id: string; title: string; summary: string; aliases: string[] };
  relationshipType?: ReasoningType; explanation: string;
  evidence: Array<{ observationId: string; evidenceIds: string[] }>;
};
export type ReconciliationContext = { observations: Observation[]; concepts: Array<{id:string;title:string;summary:string;aliases:string[];updatedAt:number}> };

export function contextSnapshot(context: ReconciliationContext) {
  return digest({ observations: context.observations.map(o => [o.id,o.fingerprint]).sort(), concepts: [...context.concepts].sort((a,b)=>a.id.localeCompare(b.id)) });
}

export function createReconciliationBatch(db: Database, episodeId: string, revisionId: string, context: ReconciliationContext, scope:'episode'|'pilot-import'='episode') {
  const sources = context.observations.filter(o => o.episodeId === episodeId && o.revisionId === revisionId);
  if (!sources.length) throw new Error('No grounded observations for this episode revision');
  const snapshot = contextSnapshot(context), id = `reconcile-${digest([episodeId,revisionId,RECONCILIATION_VERSION,snapshot,scope]).slice(0,32)}`;
  const now = Date.now();
  db.query("INSERT OR IGNORE INTO graph_reconciliation_batches(id,episode_id,revision_id,contract_version,snapshot,context_json,scope,status,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'pending',?8,?8)").run(id,episodeId,revisionId,RECONCILIATION_VERSION,snapshot,JSON.stringify(context),scope,now);
  return { id, snapshot, episodeId, revisionId, sources };
}

export function submitReconciliationProposals(db: Database, batchId: string, proposals: ReconciliationProposal[]) {
  const batch = db.query('SELECT * FROM graph_reconciliation_batches WHERE id=?1').get(batchId) as {episode_id:string;revision_id:string;context_json:string;status:string} | null;
  if (!batch || batch.status === 'stale') throw new Error('Missing or stale reconciliation batch');
  if (batch.status === 'complete') {
    const existing=db.query('SELECT proposal_json FROM graph_reconciliation_proposals WHERE batch_id=?1 ORDER BY proposal_key').all(batchId) as Array<{proposal_json:string}>;
    if(JSON.stringify(existing.map(r=>JSON.parse(r.proposal_json)))!==JSON.stringify([...proposals].sort((a,b)=>a.key.localeCompare(b.key))))throw new Error('Completed batches are immutable');
  }
  if (!Array.isArray(proposals) || proposals.length > 250 || new Set(proposals.map(p=>p.key)).size !== proposals.length) throw new Error('Invalid proposal list');
  const context: ReconciliationContext = JSON.parse(batch.context_json), byId = new Map(context.observations.map(o=>[o.id,o]));
  const ids: string[] = [];
  db.transaction(() => {
    for (const proposal of proposals) {
      const source = byId.get(proposal.sourceId), target = proposal.targetId && byId.get(proposal.targetId);
      if (!proposal.key || !source || source.episodeId !== batch.episode_id || source.revisionId !== batch.revision_id || !proposal.explanation?.trim()) throw new Error('Invalid proposal source or explanation');
      if (proposal.kind === 'relationship') {
        if (!target || target.episodeId === source.episodeId || !REASONING_TYPES.includes(proposal.relationshipType!)) throw new Error('Invalid cross-episode relationship');
      } else if (proposal.kind === 'concept') {
        const c = proposal.concept;
        if (!c || !/^[a-z0-9][a-z0-9-]{1,79}$/.test(c.id) || !c.title?.trim() || !c.summary?.trim() || !Array.isArray(c.aliases) || c.aliases.some(a=>typeof a !== 'string'||!a.trim())) throw new Error('Invalid canonical concept');
        const existing = context.concepts.find(item=>item.id === c.id);
        if (existing && (existing.title !== c.title || existing.summary !== c.summary)) throw new Error('Existing concept definition cannot be rewritten by a mention');
      } else throw new Error('Invalid proposal kind');
      const endpoints = proposal.kind === 'relationship' ? [source,target as Observation] : [source];
      if (!Array.isArray(proposal.evidence) || proposal.evidence.length !== endpoints.length) throw new Error('Evidence required for each endpoint');
      for (const endpoint of endpoints) {
        const refs = proposal.evidence.filter(e=>e.observationId === endpoint.id);
        if (refs.length !== 1 || !Array.isArray(refs[0]!.evidenceIds) || !refs[0]!.evidenceIds.length || refs[0]!.evidenceIds.some(id=>!endpoint.evidence.some(e=>e.id===id))) throw new Error('Unknown or missing endpoint evidence');
      }
      const id = `proposal-${digest([batchId,proposal.key]).slice(0,32)}`, json = JSON.stringify(proposal);
      const existing = db.query('SELECT proposal_json FROM graph_reconciliation_proposals WHERE id=?1').get(id) as {proposal_json:string} | null;
      if (existing && existing.proposal_json !== json) throw new Error('Proposal replay differs; use a new key');
      db.query("INSERT OR IGNORE INTO graph_reconciliation_proposals VALUES(?1,?2,?3,?4,'proposed')").run(id,batchId,proposal.key,json);
      ids.push(id);
    }
    // An explicit empty list is a valid reviewed-no-candidates outcome to review,
    // never an excuse to manufacture edges. Batch completion is explicit below.
    db.query("UPDATE graph_reconciliation_batches SET status=CASE WHEN status='complete' THEN status ELSE 'review' END,updated_at=?2 WHERE id=?1").run(batchId,Date.now());
  })();
  return ids;
}

export function reviewReconciliationProposal(db: Database, proposalId: string, decision: 'accepted'|'rejected', reviewer: string, rationale: string, current: ReconciliationContext, method = 'editor-explicit-review') {
  if (!reviewer.trim() || !rationale.trim() || !['editor-explicit-review','agent-editorial-review'].includes(method) || !['accepted','rejected'].includes(decision)) throw new Error('Explicit review attribution and rationale required');
  const row = db.query('SELECT p.*,b.snapshot FROM graph_reconciliation_proposals p JOIN graph_reconciliation_batches b ON b.id=p.batch_id WHERE p.id=?1').get(proposalId) as {proposal_json:string;state:string;batch_id:string;snapshot:string} | null;
  if (!row) throw new Error('Unknown proposal');
  if (row.snapshot !== contextSnapshot(current)) throw new Error('Archive changed; rebuild proposal against current sources');
  if (row.state !== 'proposed') {
    if (row.state === decision) return { replay:true };
    throw new Error('Decision already recorded; supersede through a new reviewed proposal');
  }
  db.transaction(() => {
    const proposal:ReconciliationProposal=JSON.parse(row.proposal_json);
    assertCurrentObservation(db,observationById(db,proposal.sourceId));
    if(proposal.targetId)assertCurrentObservation(db,observationById(db,proposal.targetId));
    db.query('INSERT INTO graph_reconciliation_decisions VALUES(?1,?2,?3,?4,?5,?6,?7)').run(crypto.randomUUID(),proposalId,decision,reviewer,method,rationale,Date.now());
    db.query('UPDATE graph_reconciliation_proposals SET state=?2 WHERE id=?1').run(proposalId,decision);
  })();
  return { replay:false };
}

export function finishReconciliationBatch(db: Database, batchId: string, current: ReconciliationContext) {
  const row = db.query('SELECT snapshot,status FROM graph_reconciliation_batches WHERE id=?1').get(batchId) as {snapshot:string;status:string} | null;
  if(row?.status==='complete')return;
  if (!row || row.snapshot !== contextSnapshot(current) || row.status === 'pending' || row.status === 'stale') throw new Error('Batch must be submitted against current archive');
  const pending = db.query("SELECT COUNT(*) count FROM graph_reconciliation_proposals WHERE batch_id=?1 AND state IN ('proposed','stale')").get(batchId) as {count:number};
  if (pending.count) throw new Error('Review outstanding proposals before completion');
  db.transaction(()=>{
    for(const observation of current.observations)assertCurrentObservation(db,observation);
    const concepts=db.query("SELECT proposal_json FROM graph_reconciliation_proposals WHERE batch_id=?1 AND state='accepted'").all(batchId) as Array<{proposal_json:string}>;
    const definitions=new Map<string,string>();
    for(const item of concepts){
      const proposal:ReconciliationProposal=JSON.parse(item.proposal_json);if(proposal.kind!=='concept')continue;
      const c=proposal.concept!,definition=JSON.stringify([c.title,c.summary]);
      if(definitions.has(c.id)&&definitions.get(c.id)!==definition)throw new Error('Conflicting concept definitions in batch');definitions.set(c.id,definition);
      const existing=db.query('SELECT title,summary,review_state FROM canonical_concepts WHERE id=?1').get(c.id) as {title:string;summary:string;review_state:string}|null;
      if(existing&&(existing.title!==c.title||existing.summary!==c.summary||existing.review_state!=='accepted'))throw new Error('Concept conflict; explicit merge review required');
      const source=observationById(db,proposal.sourceId);
      const decision=db.query("SELECT reviewer FROM graph_reconciliation_decisions WHERE proposal_id=(SELECT id FROM graph_reconciliation_proposals WHERE batch_id=?1 AND proposal_key=?2) AND decision='accepted'").get(batchId,proposal.key) as {reviewer:string};
      db.query("INSERT OR IGNORE INTO canonical_concepts(id,title,summary,review_state,rationale,reviewed_by,updated_at) VALUES(?1,?2,?3,'accepted',?4,?5,?6)").run(c.id,c.title,c.summary,proposal.explanation,decision.reviewer,Date.now());
      db.query('INSERT OR IGNORE INTO canonical_concept_mentions VALUES(?1,?2)').run(c.id,source.nodeId);
      for(const alias of c.aliases)db.query('INSERT OR IGNORE INTO graph_concept_aliases VALUES(?1,?2)').run(c.id,alias.trim());
    }
    db.query("UPDATE graph_reconciliation_batches SET status='complete',updated_at=?2 WHERE id=?1").run(batchId,Date.now());
    db.query("UPDATE graph_reconciliation_jobs SET status='complete',updated_at=?2 WHERE batch_id=?1").run(batchId,Date.now());
  })();
}

export function enqueueReconciliation(db: Database, episodeId: string, revisionId: string) {
  db.query("INSERT OR IGNORE INTO graph_reconciliation_jobs VALUES(?1,?2,?3,'queued',NULL,NULL,?4)").run(episodeId,revisionId,RECONCILIATION_VERSION,Date.now());
}

export function acceptedReconciliation(db: Database, current: ReconciliationContext) {
  const byId = new Map(current.observations.map(o=>[o.id,o]));
  const rows = db.query("SELECT p.id,p.proposal_json,d.reviewer,d.method,d.rationale,d.created_at FROM graph_reconciliation_proposals p JOIN graph_reconciliation_decisions d ON d.proposal_id=p.id JOIN graph_reconciliation_batches b ON b.id=p.batch_id WHERE p.state='accepted' AND d.decision='accepted' AND b.status='complete' ORDER BY p.id").all() as Array<{id:string;proposal_json:string;reviewer:string;method:string;rationale:string;created_at:number}>;
  return rows.flatMap(row => {
    const proposal: ReconciliationProposal = JSON.parse(row.proposal_json);
    // New unrelated archive material does not invalidate prior decisions, but
    // replacing either source revision does. Exact version IDs are fail-closed.
    if (!byId.has(proposal.sourceId) || (proposal.targetId && !byId.has(proposal.targetId))) return [];
    if(proposal.kind==='concept'){
      const concept=db.query("SELECT title,summary FROM canonical_concepts WHERE id=?1 AND review_state='accepted'").get(proposal.concept!.id) as {title:string;summary:string}|null;
      if(!concept||concept.title!==proposal.concept!.title||concept.summary!==proposal.concept!.summary)return [];
    }
    return [{id:row.id,...proposal,reviewer:row.reviewer,reviewMethod:row.method,reviewRationale:row.rationale,reviewedAt:new Date(row.created_at).toISOString()}];
  });
}

export function redirectIdentity(db: Database, sourceId: string, targetId: string, reviewer: string, rationale: string) {
  if (!reviewer.trim() || !rationale.trim() || sourceId === targetId) throw new Error('Explicit merge review required');
  for (const id of [sourceId,targetId]) if (!db.query('SELECT id FROM graph_observation_identities WHERE id=?1').get(id)) throw new Error('Unknown identity');
  let cursor = targetId; const seen = new Set([sourceId]);
  while (true) {
    if (seen.has(cursor)) throw new Error('Identity redirect cycle'); seen.add(cursor);
    const row = db.query('SELECT target_id FROM graph_identity_redirects WHERE source_id=?1').get(cursor) as {target_id:string}|null;
    if (!row) break; cursor=row.target_id;
  }
  db.query('INSERT INTO graph_identity_redirects VALUES(?1,?2,?3,?4,?5)').run(sourceId,targetId,reviewer,rationale,Date.now());
}
