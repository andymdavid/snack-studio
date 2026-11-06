import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {setGraphParticipants} from './graph-participants';
test('editorial participation is independent of thumbnails and accepts an explicit empty set',()=>{
 const db=new Database(':memory:');try{db.exec(`CREATE TABLE episodes(id TEXT PRIMARY KEY);CREATE TABLE contributors(id TEXT PRIMARY KEY);CREATE TABLE graph_episode_contributors(episode_id TEXT,contributor_id TEXT,source TEXT,updated_at INTEGER);CREATE TABLE graph_participant_reviews(episode_id TEXT PRIMARY KEY,reviewed_by TEXT,updated_at INTEGER);INSERT INTO episodes VALUES('e');INSERT INTO contributors VALUES('p');`);
 expect(setGraphParticipants('e',['p','p'],'reviewer',db)).toHaveLength(1);expect(setGraphParticipants('e',[],'reviewer',db)).toHaveLength(0);expect(db.query('SELECT episode_id FROM graph_participant_reviews').get()).toEqual({episode_id:'e'});expect(()=>setGraphParticipants('e',['missing'],'reviewer',db)).toThrow('Unknown contributor');}finally{db.close();}
});
