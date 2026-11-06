import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { listCanonicalConcepts, saveCanonicalConcept } from './canonical-concepts';
function fixture() {
 const db=new Database(':memory:');db.exec(`CREATE TABLE episodes(id TEXT PRIMARY KEY,active_transcript_revision_id TEXT);CREATE TABLE knowledge_nodes(id TEXT PRIMARY KEY,episode_id TEXT,source_transcript_revision_id TEXT,review_state TEXT);CREATE TABLE canonical_concepts(id TEXT PRIMARY KEY,title TEXT,summary TEXT,review_state TEXT,rationale TEXT,reviewed_by TEXT,updated_at INTEGER);CREATE TABLE canonical_concept_mentions(concept_id TEXT,knowledge_node_id TEXT,PRIMARY KEY(concept_id,knowledge_node_id));CREATE TABLE audit_events(id TEXT,actor_pubkey TEXT,action TEXT,entity_type TEXT,entity_id TEXT,detail_json TEXT,created_at INTEGER);INSERT INTO episodes VALUES('e','r');INSERT INTO knowledge_nodes VALUES('n','e','r','accepted'),('stale','e','old','accepted');`);return db;
}
test('concept review rejects stale mentions and concurrent edits; deduplicates mentions with audit',()=>{
 const db=fixture();try {
 const input={id:'graph-memory',title:'Graph memory',summary:'Related discussions retain separate claims',reviewState:'accepted' as const,mentions:['n','n'],rationale:'Both discuss retrievable connected memory'};
 expect(()=>saveCanonicalConcept({...input,mentions:['stale']},'reviewer',db)).toThrow('current accepted');
 const result=saveCanonicalConcept(input,'reviewer',db);expect(result.concepts[0]?.mentions).toEqual(['n']);
 expect(()=>saveCanonicalConcept(input,'reviewer',db)).toThrow('reload');
 expect(db.query('SELECT COUNT(*) n FROM audit_events').get()).toEqual({n:1});
 saveCanonicalConcept({...input,reviewState:'rejected',expectedUpdatedAt:result.concepts[0]!.updatedAt},'reviewer',db);
 expect(listCanonicalConcepts(db).concepts[0]?.reviewState).toBe('rejected');
 }finally{db.close();}
});
