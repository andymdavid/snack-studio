import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import {isLegacyTimestampSpeakerLabel} from './publication-metadata.ts';

export const GRAPH_COPY_SKILL_COMMIT = 'a58df065367550b6ce40ff3f648335018d8e0589';
export const graphCopyHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Hash the same evidence shown by the graph API, including hydrated speakers. */
export function graphEvidenceHash(database: Database, id: string, resolveSpeaker: (transcript: string, excerpt: string) => string | null) {
  const source = database.query(`SELECT r.transcript_text FROM knowledge_nodes n
    JOIN transcript_revisions r ON r.id=n.source_transcript_revision_id WHERE n.id=?1`).get(id) as {transcript_text: string} | null;
  const rows = database.query(`SELECT id,knowledge_node_id,excerpt,speaker,transcript_start,transcript_end
    FROM knowledge_evidence WHERE knowledge_node_id=?1 ORDER BY id`).all(id) as any[];
  if (!source || !rows.length) throw Error('Source transcript and evidence required');
  return graphCopyHash(rows.map(row => ({id:row.id,knowledgeNodeId:row.knowledge_node_id,excerpt:row.excerpt,
    speaker:row.speaker && String(row.speaker).trim() && !isLegacyTimestampSpeakerLabel(String(row.speaker)) ? row.speaker : resolveSpeaker(source.transcript_text, row.excerpt) || (row.speaker && String(row.speaker).trim() ? row.speaker : null),
    transcriptStart:row.transcript_start,transcriptEnd:row.transcript_end})));
}
const exactKeys = (value: any, keys: string[]) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value))) throw Error('Invalid copy-edit fields');
};
const text = (value: unknown, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw Error('Invalid copy-edit text');
};
/** Called only by Studio after editor authentication. No extraction, approval or publication. */
export function applyGraphCopyEdits(database: Database, input: unknown, actorPubkey: string, resolveSpeaker: (transcript: string, excerpt: string) => string | null) {
  const body = input as any;
  exactKeys(body, ['batchId','skillCommit','reviewMethod','edits']);
  text(body.batchId, 160);
  if (body.skillCommit !== GRAPH_COPY_SKILL_COMMIT || body.reviewMethod !== 'agent-source-review') throw Error('Pinned skill and source-review attribution required');
  if (!Array.isArray(body.edits) || !body.edits.length || body.edits.length > 526) throw Error('Expected 1–526 copy edits');
  if (!actorPubkey) throw Error('Editor identity required');
  const seen = new Set<string>();
  for (const edit of body.edits) {
    exactKeys(edit, ['id','episodeId','expectedTranscriptRevisionId','expectedTitle','expectedSummary','expectedUpdatedAt','expectedEvidenceHash','title','summary','reviewNote']);
    for (const name of ['id','episodeId','expectedTranscriptRevisionId']) text(edit[name], 160);
    for (const name of ['expectedTitle','title']) text(edit[name], 500);
    for (const name of ['expectedSummary','summary']) text(edit[name], 6000);
    text(edit.reviewNote, 2000);
    if (!Number.isSafeInteger(edit.expectedUpdatedAt) || !/^[a-f0-9]{64}$/.test(edit.expectedEvidenceHash)) throw Error('Expected revision guards required');
    if (seen.has(edit.id)) throw Error('Duplicate node');
    seen.add(edit.id);
    if (edit.title === edit.expectedTitle && edit.summary === edit.expectedSummary) throw Error('Copy edit has no change');
  }
  const requestHash = graphCopyHash(body);
  return database.transaction(() => {
    const audits = database.query("SELECT detail_json FROM audit_events WHERE action='graph-copy-edit-batch' AND entity_type='graph-copy-batch' AND entity_id=?1").all(body.batchId) as {detail_json: string}[];
    if (audits.length) {
      if (audits.length !== 1 || JSON.parse(audits[0]!.detail_json).requestHash !== requestHash) throw Error('Batch ID already used with different content');
      return { batchId: body.batchId, applied: false, replay: true, count: body.edits.length };
    }
    const plans = body.edits.map((edit: any) => {
      const node = database.query('SELECT * FROM knowledge_nodes WHERE id=?1').get(edit.id) as any;
      const episode = database.query('SELECT active_transcript_revision_id FROM episodes WHERE id=?1').get(edit.episodeId) as any;
      if (!node || !episode || node.episode_id !== edit.episodeId) throw Error('Node does not belong to episode');
      if (node.review_state !== 'accepted') throw Error('Only existing accepted nodes can receive this copy edit');
      if (node.source_transcript_revision_id !== edit.expectedTranscriptRevisionId || episode.active_transcript_revision_id !== edit.expectedTranscriptRevisionId) throw Error('Transcript changed; review again');
      if (node.title !== edit.expectedTitle || node.summary !== edit.expectedSummary || node.updated_at !== edit.expectedUpdatedAt) throw Error('Node changed; review again');
      if (graphEvidenceHash(database, edit.id, resolveSpeaker) !== edit.expectedEvidenceHash) throw Error('Evidence changed; review again');
      return {edit, node};
    });
    const now = Date.now();
    const update = database.query('UPDATE knowledge_nodes SET title=?1,summary=?2,updated_at=?3 WHERE id=?4');
    const audit = database.query('INSERT INTO audit_events(id,actor_pubkey,action,entity_type,entity_id,detail_json,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)');
    for (const {edit,node} of plans) {
      update.run(edit.title, edit.summary, Math.max(now, node.updated_at + 1), edit.id);
      audit.run(crypto.randomUUID(),actorPubkey,'graph-copy-edited','episode',edit.episodeId,JSON.stringify({batchId:body.batchId,skillCommit:body.skillCommit,reviewMethod:body.reviewMethod,reviewNote:edit.reviewNote,nodeId:edit.id,transcriptRevisionId:edit.expectedTranscriptRevisionId,evidenceHash:edit.expectedEvidenceHash,before:{title:node.title,summary:node.summary,updatedAt:node.updated_at},after:{title:edit.title,summary:edit.summary}}),now);
    }
    audit.run(crypto.randomUUID(),actorPubkey,'graph-copy-edit-batch','graph-copy-batch',body.batchId,JSON.stringify({requestHash,count:plans.length,skillCommit:body.skillCommit,reviewMethod:body.reviewMethod}),now);
    return { batchId: body.batchId, applied: true, replay: false, count: plans.length };
  })();
}
