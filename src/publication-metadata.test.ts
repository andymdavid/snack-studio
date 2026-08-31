import { describe, expect, test } from "bun:test";
import { resolveCanonicalTopic, resolveTranscriptParticipants, speakerForTranscriptExcerpt, transcriptHasUsableSpeakerStructure, transcriptSpeakerLabels } from "./publication-metadata.ts";

const transcript = `Pete Winn (00:01)
Welcome back.

dpc (00:15)
Thanks for inviting me.

New Guest (01:02)
Happy to be here.

Pete Winn (01:10)
Let's begin.`;

describe("publication metadata", () => {
  test("attributes an exact excerpt to its timestamped transcript speaker", () => {
    const source = '[00:01] Pete Winn\nA source-backed claim.\n\n[00:05] Andy David\nA different observation.';
    expect(speakerForTranscriptExcerpt(source, 'A source-backed claim.')).toBe('Pete Winn');
    expect(speakerForTranscriptExcerpt(source, 'A different observation.')).toBe('Andy David');
  });

  test("extracts unique diarized speaker labels in appearance order", () => {
    expect(transcriptSpeakerLabels(transcript)).toEqual(["Pete Winn", "dpc", "New Guest"]);
  });

  test("extracts timestamp-first speaker labels used by current transcripts", () => {
    const current = `[00:00:01] Pete\nWelcome.\n\n[00:00:08]\nAndy\nHello.\n\n[00:00:14] Anthony\nThanks.\n\n[00:00:20] Pete\nContinue.`;
    expect(transcriptSpeakerLabels(current)).toEqual(["Pete", "Andy", "Anthony"]);
  });

  test("extracts speaker labels with fractional-second timestamps", () => {
    const fractional = `Pete Winn (00:05.87)\nWelcome.\n\nRod (01:02.602)\nThanks for having me.`;
    expect(transcriptSpeakerLabels(fractional)).toEqual(["Pete Winn", "Rod"]);
    expect(transcriptHasUsableSpeakerStructure(`${fractional}\n${"More dialogue. ".repeat(400)}`)).toBe(true);
  });

  test("extracts speaker-colon labels followed by timestamps on the next line", () => {
    const colonFirst = `Pete:\n00:01\nWelcome to the episode.\n\nAndy:\n00:20\nGood to be here.\n\nJarad:\n00:48\nIt is good to be back.`;
    expect(transcriptSpeakerLabels(colonFirst)).toEqual(["Pete", "Andy", "Jarad"]);
  });

  test("extracts registered contributor aliases used as bare speaker headings", () => {
    const bare = `Pete\nWelcome back.\n\nAndy\nGood to be here.\n\nPete\nLet's begin.`;
    expect(transcriptSpeakerLabels(bare)).toEqual(["Pete", "Andy"]);
  });

  test("rejects an episode-length transcript with no speaker labels", () => {
    expect(transcriptHasUsableSpeakerStructure("A continuous transcript sentence. ".repeat(200))).toBe(false);
  });

  test("accepts an episode-length transcript with a recognized speaker turn", () => {
    expect(transcriptHasUsableSpeakerStructure(`Pete (00:01)\n${"Episode dialogue. ".repeat(400)}`)).toBe(true);
  });

  test("does not reject short transcript fragments", () => {
    expect(transcriptHasUsableSpeakerStructure("A short transcript fragment without labels.")).toBe(true);
  });

  test("resolves approved portraits and isolates a genuinely new guest", () => {
    const result = resolveTranscriptParticipants(transcript);
    expect(result.resolved.map(({ contributorId }) => contributorId)).toEqual(["pete-winn", "dpc"]);
    expect(result.unresolved).toEqual(["New Guest"]);
  });

  test("resolves website topic IDs and names without classification", () => {
    expect(resolveCanonicalTopic("software-systems")?.colour).toBe("#cdabfe");
    expect(resolveCanonicalTopic("AI Coding")?.id).toBe("ai-coding");
    expect(resolveCanonicalTopic(null)).toBeNull();
  });
});
