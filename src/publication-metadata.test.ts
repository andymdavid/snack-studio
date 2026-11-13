import { describe, expect, test } from "bun:test";
import { resolveCanonicalTopic, resolveTranscriptParticipants, speakerForTranscriptExcerpt, transcriptHasUsableSpeakerStructure, transcriptSpeakerLabels, transcriptSpeakerTurns } from "./publication-metadata.ts";

const transcript = `Pete Winn (00:01)
Welcome back.

dpc (00:15)
Thanks for inviting me.

New Guest (01:02)
Happy to be here.

Pete Winn (01:10)
Let's begin.`;

describe("publication metadata", () => {
  test("resolves bullet-separated legacy speaker timestamps without inventing contributors", () => {
    const source = 'Pete  •  00:00\nOpening claim.\n\nAndy  •  01:05\nA different claim.\n\nPete  •  01:02:03.500\nFinal claim.';
    expect(transcriptSpeakerLabels(source)).toEqual(['Pete', 'Andy']);
    expect(resolveTranscriptParticipants(source).unresolved).toEqual([]);
    expect(transcriptSpeakerTurns(source).map(turn => turn.speaker)).toEqual(['Pete', 'Andy', 'Pete']);
    expect(speakerForTranscriptExcerpt(source, 'Opening claim.')).toBe('Pete');
    expect(speakerForTranscriptExcerpt(source, 'A different claim.')).toBe('Andy');
    expect(speakerForTranscriptExcerpt(source, 'Final claim.')).toBe('Pete');
  });

  test("keeps unknown guests detectable in bullet-separated transcripts", () => {
    const source = 'Pete • 00:00\nHello.\n\nNew Guest • 00:20\nGuest claim.';
    expect(transcriptSpeakerLabels(source)).toEqual(['Pete', 'New Guest']);
    expect(resolveTranscriptParticipants(source).unresolved).toEqual(['New Guest']);
  });

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

  test("does not interpret minute-second timestamps as contributor names", () => {
    const timestampLines = `Pete\n00:03\nWelcome.\n\nAndy\n01:05\nHello.\n\nPete\n59:10\nContinue.`;
    expect(transcriptSpeakerLabels(timestampLines)).toEqual(["Pete", "Andy"]);
    expect(resolveTranscriptParticipants(timestampLines).unresolved).toEqual([]);
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

  test("resolves PW21 to Pete Winn while leaving Skyler as the guest", () => {
    const result = resolveTranscriptParticipants(`PW21 (00:05.654)\nWelcome.\n\nSkyler (00:21.58)\nThanks for having me.`);
    expect(result.resolved).toEqual([expect.objectContaining({ speakerLabel: "PW21", contributorId: "pete-winn", name: "Pete Winn" })]);
    expect(result.unresolved).toEqual(["Skyler"]);
  });

  test("detects an unregistered guest above a timestamp on the next line", () => {
    const transcript = `Pete\n00:06\nWelcome to the show.\n\nUnregistered Guest\n00:22\nGood to be here.\n\nAndy\n00:23\nHow are you doing?`;

    expect(transcriptSpeakerLabels(transcript)).toEqual(["Pete", "Unregistered Guest", "Andy"]);
    expect(resolveTranscriptParticipants(transcript).unresolved).toEqual(["Unregistered Guest"]);
  });

  test("resolves website topic IDs and names without classification", () => {
    expect(resolveCanonicalTopic("software-systems")?.colour).toBe("#cdabfe");
    expect(resolveCanonicalTopic("AI Coding")?.id).toBe("ai-coding");
    expect(resolveCanonicalTopic(null)).toBeNull();
  });
});
