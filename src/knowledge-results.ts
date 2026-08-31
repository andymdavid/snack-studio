import type { Database } from 'bun:sqlite';
import { db as appDb } from './db.ts';
import { CURRENT_KNOWLEDGE_GRAPH_CONTRACT, getPipelineRequest, getPipelineRequestTranscript, getPipelineRun } from './pipeline-requests.ts';
import { normalizeThemeEvidence } from './theme-results.ts';
import type { SuccessfulKnowledgeResult } from './knowledge-result-input.ts';
import type { SuccessfulKnowledgeTopicResult } from './knowledge-topic-result-input.ts';
import { discussionTopicSlug } from './discussion-topics.ts';

export function shouldPreserveExistingGraph(resultSchemaVersion: string, existingGraphNodeCount: number) {
  return resultSchemaVersion === '5' && existingGraphNodeCount > 0;
}

export function applySuccessfulKnowledgeResult(input: { localRunId: string; result: SuccessfulKnowledgeResult | SuccessfulKnowledgeTopicResult }, database: Database = appDb) {
  const request = getPipelineRequest(input.result.requestId, database); const run = getPipelineRun(input.localRunId, database);
  if (!request || !run || run.requestId !== request.id) throw new Error('pipeline callback target not found');
  if (request.status === 'completed' && request.resultAppliedAt) return { replay: true, nodeCount: input.result.nodes.length };
  if (request.operation !== 'publication-metadata' || request.episodeId !== input.result.episodeId || request.inputTranscriptRevisionId !== input.result.inputRevisionId || request.resultSchemaVersion !== input.result.resultSchemaVersion) throw new Error('knowledge callback provenance mismatch');
  if (input.result.resultSchemaVersion === '5' && request.pipelineVersion !== CURRENT_KNOWLEDGE_GRAPH_CONTRACT.pipelineVersion) throw new Error('superseded transcript topic callback');
  const transcript = getPipelineRequestTranscript(request.id, database); if (!transcript) throw new Error('pipeline transcript unavailable');
  const source = normalizeThemeEvidence(transcript.transcriptText);
  for (const node of input.result.nodes) for (const evidence of node.evidence) if (!source.includes(normalizeThemeEvidence(evidence.excerpt))) throw new Error(`Knowledge node ${node.key} evidence is not an exact transcript excerpt`);
  const topicResult = input.result.resultSchemaVersion === '5' ? input.result as SuccessfulKnowledgeTopicResult : null;
  if (topicResult) for (const passage of topicResult.topicPassages) {
    const exactRange = transcript.transcriptText.slice(passage.transcriptStart, passage.transcriptEnd);
    if (normalizeThemeEvidence(exactRange) !== normalizeThemeEvidence(passage.excerpt)) throw new Error(`Topic passage ${passage.key} evidence is not grounded in the transcript`);
  }
  const approvedCandidates = new Set((database.query("SELECT id FROM snack_candidates WHERE episode_id=?1 AND review_decision='accepted'").all(request.episodeId) as Array<{ id: string }>).map((row) => row.id));
  for (const link of input.result.snackLinks) if (!approvedCandidates.has(link.candidateId)) throw new Error('Knowledge link does not target an accepted Snack from this episode');
  const existingGraphNodeCount = Number((database.query('SELECT COUNT(*) AS count FROM knowledge_nodes WHERE episode_id=?1 AND source_transcript_revision_id=?2').get(request.episodeId, request.inputTranscriptRevisionId) as { count: number }).count);
  // Schema 5 is a topic-index backfill for transcripts whose graph may already
  // be curated. Preserve that graph wholesale; only a genuinely new transcript
  // with no graph receives the graph portion of the combined callback.
  const preserveExistingGraph = shouldPreserveExistingGraph(input.result.resultSchemaVersion, existingGraphNodeCount);
  if (topicResult && !preserveExistingGraph && !input.result.nodes.length) throw new Error('A transcript without an existing graph must return knowledge nodes');
  const now = Date.now(); const idByKey = new Map(input.result.nodes.map((node) => [node.key, crypto.randomUUID()]));
  database.transaction(() => {
    if (!preserveExistingGraph) {
      database.query("DELETE FROM knowledge_nodes WHERE episode_id=?1 AND source_transcript_revision_id=?2 AND origin='pipeline'").run(request.episodeId, request.inputTranscriptRevisionId);
      for (const node of input.result.nodes) {
        const id = idByKey.get(node.key)!; database.query(`INSERT INTO knowledge_nodes(id,episode_id,source_transcript_revision_id,kind,title,summary,confidence,review_state,origin,pipeline_request_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'accepted','pipeline',?8,?9,?9)`).run(id, request.episodeId, request.inputTranscriptRevisionId, node.kind, node.title, node.summary, node.confidence, request.id, now);
        for (const evidence of node.evidence) database.query('INSERT INTO knowledge_evidence(id,knowledge_node_id,excerpt,speaker,created_at) VALUES(?1,?2,?3,?4,?5)').run(crypto.randomUUID(), id, evidence.excerpt, evidence.speaker, now);
      }
      for (const edge of input.result.edges) database.query(`INSERT INTO knowledge_edges(id,episode_id,source_node_id,target_node_id,relationship_type,explanation,confidence,review_state,origin,pipeline_request_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'accepted','pipeline',?8,?9,?9)`).run(crypto.randomUUID(), request.episodeId, idByKey.get(edge.sourceKey)!, idByKey.get(edge.targetKey)!, edge.relationshipType, edge.explanation, edge.confidence, request.id, now);
      for (const link of input.result.snackLinks) database.query(`INSERT INTO knowledge_snack_links(id,episode_id,knowledge_node_id,candidate_id,relationship_type,confidence,review_state,origin,pipeline_request_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'accepted','pipeline',?7,?8,?8)`).run(crypto.randomUUID(), request.episodeId, idByKey.get(link.nodeKey)!, link.candidateId, link.relationshipType, link.confidence, request.id, now);
    }
    if (topicResult) {
      const existingTopics = new Set((database.query('SELECT id FROM discussion_topics').all() as Array<{ id: string }>).map((row) => row.id));
      const topicIdByKey = new Map<string, string>();
      for (const topic of topicResult.topics.filter((item) => !item.parentTopicKey)) {
        const slug = discussionTopicSlug(topic.name); const id = topic.existingTopicId || slug; if (!id) throw new Error(`Topic ${topic.key} cannot produce a stable ID`);
        if (topic.existingTopicId && !existingTopics.has(topic.existingTopicId)) throw new Error(`Unknown governed discussion topic ${topic.existingTopicId}`);
        topicIdByKey.set(topic.key, id);
      }
      for (const topic of topicResult.topics.filter((item) => item.parentTopicKey)) {
        const parentId = topic.parentTopicKey ? topicIdByKey.get(topic.parentTopicKey) : null;
        const slug = discussionTopicSlug(topic.name); const id = topic.existingTopicId || (parentId && slug ? `${parentId}--${slug}`.slice(0, 160) : slug); if (!id) throw new Error(`Topic ${topic.key} cannot produce a stable ID`);
        if (topic.existingTopicId && !existingTopics.has(topic.existingTopicId)) throw new Error(`Unknown governed discussion topic ${topic.existingTopicId}`);
        topicIdByKey.set(topic.key, id);
      }
      for (const topic of topicResult.topics) {
        const id = topicIdByKey.get(topic.key)!;
        database.query(`INSERT INTO discussion_topics(id,name,description,parent_topic_id,source,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)
          ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at`)
          .run(id, topic.name, topic.description, null, topic.existingTopicId ? 'seed' : 'pipeline', now);
      }
      for (const topic of topicResult.topics) if (topic.parentTopicKey) database.query('UPDATE discussion_topics SET parent_topic_id=?1,updated_at=?2 WHERE id=?3').run(topicIdByKey.get(topic.parentTopicKey)!, now, topicIdByKey.get(topic.key)!);
      database.query('DELETE FROM transcript_topic_analyses WHERE episode_id=?1 AND transcript_revision_id=?2').run(request.episodeId, request.inputTranscriptRevisionId);
      const analysisId = crypto.randomUUID(); const totalWordCount = transcript.transcriptText.trim().split(/\s+/).filter(Boolean).length; const classifiedWordCount = topicResult.topicPassages.reduce((sum, passage) => sum + passage.wordCount, 0);
      database.query('INSERT INTO transcript_topic_analyses(id,episode_id,transcript_revision_id,pipeline_request_id,total_word_count,classified_word_count,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)').run(analysisId, request.episodeId, request.inputTranscriptRevisionId, request.id, totalWordCount, classifiedWordCount, now);
      for (const passage of topicResult.topicPassages) {
        const passageId = crypto.randomUUID(); const primaryTopicId = topicIdByKey.get(passage.primaryTopicKey)!;
        database.query(`INSERT INTO transcript_topic_passages(id,analysis_id,episode_id,transcript_revision_id,primary_topic_id,summary,evidence_ids_json,evidence_excerpt,transcript_start,transcript_end,word_count,confidence,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`).run(passageId, analysisId, request.episodeId, request.inputTranscriptRevisionId, primaryTopicId, passage.summary, JSON.stringify(passage.evidenceIds), passage.excerpt, passage.transcriptStart, passage.transcriptEnd, passage.wordCount, passage.confidence, now);
        for (const topicKey of passage.secondaryTopicKeys) database.query('INSERT INTO transcript_topic_secondary(passage_id,topic_id) VALUES(?1,?2)').run(passageId, topicIdByKey.get(topicKey)!);
      }
    }
    database.query("INSERT INTO pipeline_artifacts(id,request_id,run_id,artifact_type,schema_version,content_json,created_at) VALUES(?1,?2,?3,'transcript-knowledge',?4,?5,?6)").run(crypto.randomUUID(), request.id, run.id, input.result.resultSchemaVersion, JSON.stringify({ nodeCount: preserveExistingGraph ? existingGraphNodeCount : input.result.nodes.length, generatedNodeCount: input.result.nodes.length, edgeCount: input.result.edges.length, snackLinkCount: input.result.snackLinks.length, graphPreserved: preserveExistingGraph, topicPassageCount: topicResult?.topicPassages.length || 0 }), now);
    database.query("UPDATE pipeline_runs SET status='complete',progress_percent=100,progress_label=?1,completed_at=?2,updated_at=?2 WHERE id=?3").run(topicResult ? 'Transcript topic index ready' : 'Knowledge graph ready', now, run.id);
    database.query("UPDATE pipeline_requests SET status='completed',pipeline_version=COALESCE(?1,pipeline_version),result_applied_at=?2,failure_summary=NULL,updated_at=?2 WHERE id=?3").run(input.result.pipelineVersion, now, request.id);
  })();
  return { replay: false, nodeCount: preserveExistingGraph ? existingGraphNodeCount : input.result.nodes.length, edgeCount: input.result.edges.length, snackLinkCount: input.result.snackLinks.length, graphPreserved: preserveExistingGraph, topicPassageCount: topicResult?.topicPassages.length || 0 };
}
