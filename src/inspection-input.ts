import type {Episode} from './episodes.ts';
import {validateEpisodeMetadata} from './transcript-input.ts';

/** Inspection may complete public copy and its video link, never change episode identity or source. */
export function planInspectionMetadata(current: Episode, patch: unknown) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)
    || Object.keys(patch).some(key => !['publicTitle','publicSummary','videoUrl'].includes(key))) {
    throw Error('Inspection metadata accepts only publicTitle, publicSummary and videoUrl');
  }
  const checked = validateEpisodeMetadata({...current, ...patch});
  if (!checked.ok) throw Error(checked.error);
  return checked.value;
}
