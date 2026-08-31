import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { assembleKnowledgeGraph, getEpisodeGraphReadiness, hydrateMissingEvidenceSpeakers, listKnowledgeBackfill } from './knowledge-graph.ts';

const databases: Database[] = [];

function backfillDatabase() {
  const database = new Database(':memory:');
  databases.push(database);
  database.exec(`
    CREATE TABLE episodes(
      id TEXT PRIMARY KEY, episode_number INTEGER, working_title TEXT NOT NULL,
      active_transcript_revision_id TEXT
    );
    CREATE TABLE snack_candidates(
      id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, review_decision TEXT NOT NULL
    );
    CREATE TABLE pipeline_requests(
      id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, pipeline_name TEXT NOT NULL,
      pipeline_version TEXT, result_schema_version TEXT NOT NULL, status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
  `);
  database.query("INSERT INTO episodes VALUES ('episode-67', 67, 'Episode 67', 'revision-67')").run();
  database.query("INSERT INTO snack_candidates VALUES ('snack-67', 'episode-67', 'accepted')").run();
  return database;
}

afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

describe('assembleKnowledgeGraph', () => {
  test('keeps proposed transcript knowledge visible with grounded evidence and Snack links', () => {
    const graph = assembleKnowledgeGraph([
      { id: 'claim-1', episode_id: 'episode-1', source_transcript_revision_id: 'revision-1', kind: 'claim', title: 'Memory compounds', summary: 'Connected memory becomes more useful over time.', confidence: 0.86, review_state: 'proposed', origin: 'pipeline', created_at: 1, updated_at: 1 },
    ], [
      { id: 'evidence-1', knowledge_node_id: 'claim-1', excerpt: 'The more connected it gets, the more useful it becomes.', speaker: 'Pete', transcript_start: 120, transcript_end: 178 },
    ], [], [
      { id: 'link-1', episode_id: 'episode-1', knowledge_node_id: 'claim-1', candidate_id: 'snack-1', relationship_type: 'developed-into', confidence: 0.9, review_state: 'proposed', origin: 'pipeline' },
    ]);
    expect(graph.nodes[0]).toMatchObject({ kind: 'claim', reviewState: 'proposed', confidence: 0.86 });
    expect(graph.nodes[0]?.evidence[0]).toMatchObject({ speaker: 'Pete', transcriptStart: 120 });
    expect(graph.snackLinks[0]).toMatchObject({ candidateId: 'snack-1', relationshipType: 'developed-into' });
  });
});

test('hydrates missing evidence speakers from the immutable transcript turn', () => {
  const nodes = [{ id: 'claim-1', source_transcript_revision_id: 'revision-1' }];
  const evidence = [{ id: 'evidence-1', knowledge_node_id: 'claim-1', excerpt: 'The exact attributed sentence.', speaker: null }];
  const transcript = '[00:01] Pete Winn\nThe exact attributed sentence.\n\n[00:05] Andy David\nAnother sentence.';
  expect(hydrateMissingEvidenceSpeakers(nodes, evidence, new Map([['revision-1', transcript]]))[0]?.speaker).toBe('Pete Winn');
});

describe('listKnowledgeBackfill', () => {
  test('offers one bounded retry, then stops retrying a failed graph request', () => {
    const database = backfillDatabase();
    expect(listKnowledgeBackfill(database)[0]?.status).toBe('not-started');

    const insert = database.query(`
      INSERT INTO pipeline_requests(
        id, episode_id, pipeline_name, pipeline_version, result_schema_version,
        status, attempt_count, created_at
      ) VALUES (?1, 'episode-67', 'snack-studio-graph-relationships', '7', '5', ?2, ?3, ?4)
    `);
    insert.run('request-1', 'failed', 1, 1);
    expect(listKnowledgeBackfill(database)[0]?.status).toBe('retryable');

    insert.run('request-2', 'failed', 2, 2);
    expect(listKnowledgeBackfill(database)[0]?.status).toBe('failed');
  });

  test('ignores obsolete graph pipeline versions when deciding backfill state', () => {
    const database = backfillDatabase();
    database.query(`
      INSERT INTO pipeline_requests VALUES(
        'request-v2', 'episode-67', 'snack-studio-graph-relationships', '2', '3', 'completed', 1, 1
      )
    `).run();
    expect(listKnowledgeBackfill(database)[0]?.status).toBe('not-started');
  });
});

test('graph readiness requires the current v7 result and its durable knowledge and topic records', () => {
  const database = new Database(':memory:'); databases.push(database);
  database.exec(`
    CREATE TABLE episodes(id TEXT PRIMARY KEY, active_transcript_revision_id TEXT);
    CREATE TABLE pipeline_requests(id TEXT PRIMARY KEY, episode_id TEXT, input_transcript_revision_id TEXT, pipeline_name TEXT, pipeline_version TEXT, prompt_suite_version TEXT, result_schema_version TEXT, status TEXT, failure_summary TEXT, updated_at INTEGER, created_at INTEGER);
    CREATE TABLE knowledge_nodes(id TEXT PRIMARY KEY, episode_id TEXT, source_transcript_revision_id TEXT);
    CREATE TABLE knowledge_edges(id TEXT PRIMARY KEY, episode_id TEXT);
    CREATE TABLE transcript_topic_analyses(id TEXT PRIMARY KEY, episode_id TEXT, transcript_revision_id TEXT);
    CREATE TABLE transcript_topic_passages(id TEXT PRIMARY KEY, episode_id TEXT, transcript_revision_id TEXT);
    INSERT INTO episodes VALUES('episode-1','revision-1');
  `);
  expect(getEpisodeGraphReadiness('episode-1', database).state).toBe('not-started');
  database.query("INSERT INTO pipeline_requests VALUES('request-1','episode-1','revision-1','snack-studio-graph-relationships','7','v7-governed-roots-reusable-subtopics','5','completed',NULL,2,1)").run();
  expect(getEpisodeGraphReadiness('episode-1', database).state).toBe('incomplete');
  database.query("INSERT INTO knowledge_nodes VALUES('node-1','episode-1','revision-1')").run();
  database.query("INSERT INTO transcript_topic_analyses VALUES('analysis-1','episode-1','revision-1')").run();
  database.query("INSERT INTO transcript_topic_passages VALUES('passage-1','episode-1','revision-1')").run();
  expect(getEpisodeGraphReadiness('episode-1', database)).toMatchObject({ state: 'complete', ready: true, nodeCount: 1, passageCount: 1 });
});
