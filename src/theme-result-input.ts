import { listThemes } from './themes.ts';

export type SuccessfulThemeResult = {
  requestId: string; attemptId: string; runId: string | null; episodeId: string;
  operation: 'publication-metadata'; inputRevisionId: string; resultSchemaVersion: string; pipelineVersion: string;
  episodeThemes: Array<{ key: string; existingThemeId: string | null; name: string; description: string; rationale: string; evidenceExcerpt: string }>;
  snackAssignments: Array<{ candidateId: string; revisionId: string; themeKeys: string[]; visualThemeKey: string; rationale: string }>;
};

export function validateSuccessfulThemeResult(value: Record<string, unknown>): { ok: true; value: SuccessfulThemeResult } | { ok: false; error: string } {
  try {
    const required = (key: string) => { const item = typeof value[key] === 'string' ? String(value[key]).trim() : ''; if (!item) throw new Error(`${key} is required`); return item; };
    if (value.operation !== 'publication-metadata') throw new Error('operation must be publication-metadata');
    if (!Array.isArray(value.episodeThemes) || value.episodeThemes.length < 2 || value.episodeThemes.length > 12) throw new Error('episodeThemes must contain 2 to 12 grounded themes');
    const catalog = new Set(listThemes().map((item) => item.id));
    const episodeThemes = value.episodeThemes.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`episode theme ${index + 1} must be an object`);
      const row = item as Record<string, unknown>; const key = String(row.key || '').trim(); const existingThemeId = typeof row.existingThemeId === 'string' && row.existingThemeId.trim() ? row.existingThemeId.trim() : null;
      const name = String(row.name || '').trim(); const description = String(row.description || '').trim(); const rationale = String(row.rationale || '').trim(); const evidenceExcerpt = String(row.evidenceExcerpt || '').trim();
      if (!key || !name || !description || !rationale || !evidenceExcerpt) throw new Error(`episode theme ${index + 1} is incomplete`);
      if (existingThemeId && !catalog.has(existingThemeId)) throw new Error(`episode theme ${key} references an unknown existing theme`);
      return { key, existingThemeId, name, description, rationale, evidenceExcerpt };
    });
    const keys = new Set(episodeThemes.map((item) => item.key)); if (keys.size !== episodeThemes.length) throw new Error('episode theme keys must be unique');
    if (!Array.isArray(value.snackAssignments) || !value.snackAssignments.length) throw new Error('snackAssignments are required');
    const snackAssignments = value.snackAssignments.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Snack assignment ${index + 1} must be an object`);
      const row = item as Record<string, unknown>; const candidateId = String(row.candidateId || '').trim(); const revisionId = String(row.revisionId || '').trim();
      const themeKeys = Array.isArray(row.themeKeys) ? [...new Set(row.themeKeys.map(String).map((entry) => entry.trim()).filter(Boolean))] : [];
      const visualThemeKey = String(row.visualThemeKey || '').trim(); const rationale = String(row.rationale || '').trim();
      if (!candidateId || !revisionId || !themeKeys.length || themeKeys.length > 4 || !rationale) throw new Error(`Snack assignment ${index + 1} is incomplete`);
      if (themeKeys.some((key) => !keys.has(key)) || !themeKeys.includes(visualThemeKey)) throw new Error(`Snack assignment ${index + 1} must use episode theme keys and include its visual theme`);
      return { candidateId, revisionId, themeKeys, visualThemeKey, rationale };
    });
    return { ok: true, value: { requestId: required('requestId'), attemptId: required('attemptId'), runId: typeof value.runId === 'string' ? value.runId : null, episodeId: required('episodeId'), operation: 'publication-metadata', inputRevisionId: required('inputRevisionId'), resultSchemaVersion: required('resultSchemaVersion'), pipelineVersion: required('pipelineVersion'), episodeThemes, snackAssignments } };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}
