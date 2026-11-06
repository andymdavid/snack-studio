import type { Database } from 'bun:sqlite';
import { db } from './db';
export function listGraphParticipants(database: Database = db) {
 return database.query('SELECT episode_id,contributor_id,source,updated_at FROM graph_episode_contributors ORDER BY episode_id,contributor_id').all();
}
export function setGraphParticipants(episodeId: string, contributorIds: string[], actor: string, database: Database = db) {
 if(!database.query('SELECT id FROM episodes WHERE id=?1').get(episodeId))throw new Error('Unknown episode');
 if(!Array.isArray(contributorIds)||contributorIds.length>30||contributorIds.some(id=>typeof id!=='string'||!database.query('SELECT id FROM contributors WHERE id=?1').get(id)))throw new Error('Unknown contributor');
 database.transaction(()=>{
  database.query('DELETE FROM graph_episode_contributors WHERE episode_id=?1').run(episodeId);
  // A marker preserves an explicitly empty participant set instead of falling back to artwork metadata.
  database.query('INSERT INTO graph_participant_reviews(episode_id,reviewed_by,updated_at) VALUES(?1,?2,?3) ON CONFLICT(episode_id) DO UPDATE SET reviewed_by=excluded.reviewed_by,updated_at=excluded.updated_at').run(episodeId,actor,Date.now());
  for(const id of new Set(contributorIds))database.query("INSERT INTO graph_episode_contributors(episode_id,contributor_id,source,updated_at) VALUES(?1,?2,'editor',?3)").run(episodeId,id,Date.now());
 })();return listGraphParticipants(database);
}
