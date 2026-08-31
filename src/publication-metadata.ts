import { THUMBNAIL_TOPICS } from "./thumbnail-catalog.ts";
import { listContributors } from "./contributors.ts";

export type ResolvedParticipant = {
  speakerLabel: string;
  contributorId: string;
  name: string;
  referenceImage: string;
};

function normalizedLabel(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

type TranscriptSpeakerTurn = { speaker: string; headerStart: number; contentStart: number; contentEnd: number };

export function transcriptSpeakerTurns(transcriptText: string): TranscriptSpeakerTurn[] {
  const matches = [
    ...[...transcriptText.matchAll(/^([^\n()]{1,100})\s+\((?:\d{1,2}:)?\d{2}(?:[.,]\d+)?\)\s*$/gm)],
    ...[...transcriptText.matchAll(/^([^\n:]{1,100}):[ \t]*(?:\n[ \t]*)?((?:\d{1,2}:)?\d{2}(?::\d{2})?(?:[.,]\d+)?)[ \t]*$/gm)],
    ...[...transcriptText.matchAll(/^\[(?:\d{1,2}:)?\d{2}(?::\d{2})?(?:[.,]\d+)?\][ \t]*([^\n]{1,100})[ \t]*$/gm)],
    ...[...transcriptText.matchAll(/^\[(?:\d{1,2}:)?\d{2}(?::\d{2})?(?:[.,]\d+)?\][ \t]*\n([^\n]{1,100})[ \t]*$/gm)],
    ...listContributors().flatMap(({ aliases }) => aliases.flatMap((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return [...transcriptText.matchAll(new RegExp(`^${escaped}[ \\t]*$`, "gmi"))];
    })),
  ].map((match) => ({ speaker: String(match[1] || match[0]).trim(), headerStart: match.index!, contentStart: match.index! + match[0].length }))
    .sort((a, b) => a.headerStart - b.headerStart || b.contentStart - a.contentStart);
  const unique = matches.filter((match, index) => index === 0 || match.headerStart !== matches[index - 1]!.headerStart);
  return unique.map((match, index) => ({ ...match, contentEnd: unique[index + 1]?.headerStart ?? transcriptText.length }));
}

export function speakerForTranscriptExcerpt(transcriptText: string, excerpt: string): string | null {
  if (!excerpt) return null;
  const speakers = new Set<string>();
  for (const turn of transcriptSpeakerTurns(transcriptText)) {
    const index = transcriptText.indexOf(excerpt, turn.contentStart);
    if (index >= turn.contentStart && index < turn.contentEnd && index + excerpt.length <= turn.contentEnd) speakers.add(turn.speaker);
  }
  return speakers.size === 1 ? [...speakers][0]! : null;
}

export function transcriptSpeakerLabels(transcriptText: string): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  const matches = [
    ...[...transcriptText.matchAll(/^([^\n()]{1,100})\s+\((?:\d{1,2}:)?\d{2}(?:[.,]\d+)?\)\s*$/gm)].map((match) => ({ index: match.index, label: match[1] })),
    ...[...transcriptText.matchAll(/^([^\n:]{1,100}):[ \t]*(?:\n[ \t]*)?((?:\d{1,2}:)?\d{2}(?::\d{2})?(?:[.,]\d+)?)[ \t]*$/gm)].map((match) => ({ index: match.index, label: match[1] })),
    ...[...transcriptText.matchAll(/^\[(?:\d{1,2}:)?\d{2}(?::\d{2})?(?:[.,]\d+)?\][ \t]*([^\n]{1,100})[ \t]*$/gm)].map((match) => ({ index: match.index, label: match[1] })),
    ...[...transcriptText.matchAll(/^\[(?:\d{1,2}:)?\d{2}(?::\d{2})?(?:[.,]\d+)?\][ \t]*\n([^\n]{1,100})[ \t]*$/gm)].map((match) => ({ index: match.index, label: match[1] })),
    // Some edited transcripts use a known contributor alias on its own line
    // without a timestamp. Restrict this form to registered aliases so prose
    // such as a short standalone sentence cannot become a speaker label.
    ...listContributors().flatMap(({ aliases }) => aliases.flatMap((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return [...transcriptText.matchAll(new RegExp(`^${escaped}[ \\t]*$`, "gmi"))]
        .map((match) => ({ index: match.index, label: match[0].trim() }));
    })),
  ].sort((a, b) => a.index - b.index);
  for (const match of matches) {
    const label = match.label!.trim();
    const key = normalizedLabel(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  return labels;
}

export function transcriptHasUsableSpeakerStructure(transcriptText: string): boolean {
  // Short notes and fragments may legitimately contain no speaker turns. This
  // guard targets episode-length transcripts where lost diarization would
  // materially damage extraction and attribution.
  if (transcriptText.trim().length < 5_000) return true;
  return transcriptSpeakerLabels(transcriptText).length > 0;
}

export function resolveTranscriptParticipants(transcriptText: string): {
  resolved: ResolvedParticipant[];
  unresolved: string[];
} {
  const resolved: ResolvedParticipant[] = [];
  const unresolved: string[] = [];
  for (const speakerLabel of transcriptSpeakerLabels(transcriptText)) {
    const normalized = normalizedLabel(speakerLabel);
    const contributor = listContributors().find(({ aliases }) => aliases.some((alias) => normalizedLabel(alias) === normalized));
    if (!contributor) {
      unresolved.push(speakerLabel);
      continue;
    }
    resolved.push({
      speakerLabel,
      contributorId: contributor.id,
      name: contributor.name,
      referenceImage: contributor.portraitPath || '',
    });
  }
  return { resolved, unresolved };
}

export function resolveCanonicalTopic(value: string | null | undefined) {
  if (!value?.trim()) return null;
  const normalized = normalizedLabel(value);
  return THUMBNAIL_TOPICS.find((topic) => normalizedLabel(topic.id) === normalized || normalizedLabel(topic.name) === normalized) || null;
}
