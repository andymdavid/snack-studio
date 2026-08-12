export type SuccessfulPublicTranscriptResult = { requestId: string; attemptId: string; runId: string | null; episodeId: string; operation: 'transcript-normalization'; inputRevisionId: string; resultSchemaVersion: string; pipelineVersion: string; transcriptText: string; cleanupSummary: string[] };

export function validateSuccessfulPublicTranscriptResult(value: Record<string, unknown>): { ok: true; value: SuccessfulPublicTranscriptResult } | { ok: false; error: string } {
  try {
    const required = (key: string) => { const result = typeof value[key] === 'string' ? String(value[key]).trim() : ''; if (!result) throw new Error(`${key} is required`); return result; };
    if (value.operation !== 'transcript-normalization') throw new Error('operation must be transcript-normalization');
    const transcriptText = required('transcriptText'); if (transcriptText.length < 100) throw new Error('transcriptText is too short');
    if (!Array.isArray(value.cleanupSummary)) throw new Error('cleanupSummary must be an array');
    return { ok: true, value: { requestId: required('requestId'), attemptId: required('attemptId'), runId: typeof value.runId === 'string' ? value.runId : null,
      episodeId: required('episodeId'), operation: 'transcript-normalization', inputRevisionId: required('inputRevisionId'), resultSchemaVersion: required('resultSchemaVersion'),
      pipelineVersion: required('pipelineVersion'), transcriptText, cleanupSummary: value.cleanupSummary.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 20) } };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}
