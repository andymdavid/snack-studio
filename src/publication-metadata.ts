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

export function transcriptSpeakerLabels(transcriptText: string): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  const matches = [
    ...[...transcriptText.matchAll(/^([^\n()]{1,100})\s+\((?:\d{1,2}:)?\d{2}\)\s*$/gm)].map((match) => ({ index: match.index, label: match[1] })),
    ...[...transcriptText.matchAll(/^\[(?:\d{1,2}:)?\d{2}(?::\d{2})?\][ \t]*([^\n]{1,100})[ \t]*$/gm)].map((match) => ({ index: match.index, label: match[1] })),
    ...[...transcriptText.matchAll(/^\[(?:\d{1,2}:)?\d{2}(?::\d{2})?\][ \t]*\n([^\n]{1,100})[ \t]*$/gm)].map((match) => ({ index: match.index, label: match[1] })),
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
