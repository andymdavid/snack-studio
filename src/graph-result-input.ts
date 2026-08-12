import { RELATIONSHIP_TYPES, type RelationshipType } from './curation.ts';
export type SuccessfulGraphResult = { requestId: string; attemptId: string; runId: string | null; episodeId: string; operation: 'publication-metadata'; inputRevisionId: string; resultSchemaVersion: '3'; pipelineVersion: string; suggestions: Array<{ sourceCandidateId: string; targetCandidateId: string; relationshipType: RelationshipType; explanation: string; evidence: string }> };
export function validateSuccessfulGraphResult(value: Record<string, unknown>): { ok: true; value: SuccessfulGraphResult } | { ok: false; error: string } {
  try { const required = (key: string) => { const result = typeof value[key] === 'string' ? String(value[key]).trim() : ''; if (!result) throw new Error(`${key} is required`); return result; };
    if (value.operation !== 'publication-metadata' || value.resultSchemaVersion !== '3') throw new Error('graph callback contract mismatch');
    if (!Array.isArray(value.suggestions)) throw new Error('suggestions must be an array');
    const suggestions = value.suggestions.map((raw, index) => { if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`suggestion ${index + 1} must be an object`); const row = raw as Record<string, unknown>;
      const sourceCandidateId = String(row.sourceCandidateId || '').trim(), targetCandidateId = String(row.targetCandidateId || '').trim(), relationshipType = String(row.relationshipType || '') as RelationshipType, explanation = String(row.explanation || '').trim(), evidence = String(row.evidence || '').trim();
      if (!sourceCandidateId || !targetCandidateId || !RELATIONSHIP_TYPES.includes(relationshipType) || !explanation || !evidence) throw new Error(`suggestion ${index + 1} is incomplete`); return { sourceCandidateId, targetCandidateId, relationshipType, explanation, evidence }; });
    return { ok: true, value: { requestId: required('requestId'), attemptId: required('attemptId'), runId: typeof value.runId === 'string' ? value.runId : null, episodeId: required('episodeId'), operation: 'publication-metadata', inputRevisionId: required('inputRevisionId'), resultSchemaVersion: '3', pipelineVersion: required('pipelineVersion'), suggestions } };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}
