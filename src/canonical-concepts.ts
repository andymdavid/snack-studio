import type { Database } from 'bun:sqlite';
import { db } from './db';
export type ConceptInput = { id: string; title: string; summary: string; reviewState: 'proposed' | 'accepted' | 'rejected'; mentions: string[]; rationale: string; expectedUpdatedAt?: number };
export function listCanonicalConcepts(database: Database = db) {
  return { version: 1, concepts: (database.query('SELECT * FROM canonical_concepts ORDER BY title').all() as Record<string,unknown>[]).map(row=>({ id:String(row.id),title:String(row.title),summary:String(row.summary),reviewState:String(row.review_state),reviewer:row.reviewed_by,reviewMethod:'editor-explicit-review',rationale:String(row.rationale),updatedAt:Number(row.updated_at),mentions:(database.query('SELECT knowledge_node_id FROM canonical_concept_mentions WHERE concept_id=?1').all(String(row.id)) as Array<{knowledge_node_id:string}>).map(item=>item.knowledge_node_id) })) };
}
export function saveCanonicalConcept(input: ConceptInput, actor: string, database: Database = db) {
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(input.id) || !input.title?.trim() || !input.summary?.trim() || !['proposed','accepted','rejected'].includes(input.reviewState) || !Array.isArray(input.mentions)) throw new Error('Invalid concept; use a stable lowercase ID, title, summary, review state and mention IDs');
  const mentions = [...new Set(input.mentions)];
  if (input.reviewState === 'accepted' && (!input.rationale?.trim() || !mentions.length)) throw new Error('Accepted concepts require source mentions and review rationale');
  const existing = database.query('SELECT updated_at FROM canonical_concepts WHERE id=?1').get(input.id) as {updated_at:number} | null;
  if (existing && input.expectedUpdatedAt !== existing.updated_at) throw new Error('Concept changed; reload before editing');
  for (const id of mentions) {
    const node = database.query(`SELECT n.id FROM knowledge_nodes n JOIN episodes e ON e.id=n.episode_id WHERE n.id=?1 AND n.review_state='accepted' AND n.source_transcript_revision_id=e.active_transcript_revision_id`).get(id);
    if (!node) throw new Error(`Mention must target current accepted knowledge: ${id}`);
  }
  const now = Math.max(Date.now(), (existing?.updated_at || 0) + 1);
  database.transaction(()=>{
    database.query(`INSERT INTO canonical_concepts(id,title,summary,review_state,rationale,reviewed_by,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET title=excluded.title,summary=excluded.summary,review_state=excluded.review_state,rationale=excluded.rationale,reviewed_by=excluded.reviewed_by,updated_at=excluded.updated_at`).run(input.id,input.title.trim(),input.summary.trim(),input.reviewState,input.rationale||'',actor,now);
    database.query('DELETE FROM canonical_concept_mentions WHERE concept_id=?1').run(input.id);
    for (const id of mentions) database.query('INSERT INTO canonical_concept_mentions(concept_id,knowledge_node_id) VALUES(?1,?2)').run(input.id,id);
    database.query(`INSERT INTO audit_events(id,actor_pubkey,action,entity_type,entity_id,detail_json,created_at) VALUES(?1,?2,'concept.reviewed','concept',?3,?4,?5)`).run(crypto.randomUUID(),actor,input.id,JSON.stringify({reviewState:input.reviewState,mentions,rationale:input.rationale}),now);
  })();
  return listCanonicalConcepts(database);
}
