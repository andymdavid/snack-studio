import type { Database } from 'bun:sqlite';
import { db as appDb } from './db.ts';

export function listDiscussionTopics(database: Database = appDb) {
  return (database.query('SELECT id,name,description,parent_topic_id,source FROM discussion_topics ORDER BY name COLLATE NOCASE').all() as Record<string, unknown>[]).map((row) => ({
    id: String(row.id), name: String(row.name), description: String(row.description),
    parentTopicId: row.parent_topic_id == null ? null : String(row.parent_topic_id), source: String(row.source),
  }));
}

export function listGovernedDiscussionTopics(database: Database = appDb) {
  return listDiscussionTopics(database).filter((topic) => topic.parentTopicId == null && topic.source !== 'pipeline');
}

export function listTranscriptTopicIndex(database: Database = appDb) {
  const topics = listDiscussionTopics(database);
  const analyses = database.query('SELECT * FROM transcript_topic_analyses').all() as Record<string, unknown>[];
  const passages = database.query('SELECT * FROM transcript_topic_passages ORDER BY episode_id,transcript_start').all() as Record<string, unknown>[];
  const secondaryRows = database.query('SELECT passage_id,topic_id FROM transcript_topic_secondary').all() as Record<string, unknown>[];
  const secondaryByPassage = new Map<string, string[]>();
  for (const row of secondaryRows) secondaryByPassage.set(String(row.passage_id), [...(secondaryByPassage.get(String(row.passage_id)) || []), String(row.topic_id)]);
  return {
    topics,
    analyses: analyses.map((row) => ({ id: String(row.id), episodeId: String(row.episode_id), transcriptRevisionId: String(row.transcript_revision_id), totalWordCount: Number(row.total_word_count), classifiedWordCount: Number(row.classified_word_count) })),
    passages: passages.map((row) => ({ id: String(row.id), episodeId: String(row.episode_id), transcriptRevisionId: String(row.transcript_revision_id), primaryTopicId: String(row.primary_topic_id), secondaryTopicIds: secondaryByPassage.get(String(row.id)) || [], summary: String(row.summary), excerpt: String(row.evidence_excerpt), transcriptStart: Number(row.transcript_start), transcriptEnd: Number(row.transcript_end), wordCount: Number(row.word_count), confidence: Number(row.confidence) })),
  };
}

export function discussionTopicSlug(value: string) {
  return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}
