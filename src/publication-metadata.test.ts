import { describe, expect, test } from "bun:test";
import { resolveCanonicalTopic, resolveTranscriptParticipants, transcriptSpeakerLabels } from "./publication-metadata.ts";

const transcript = `Pete Winn (00:01)
Welcome back.

dpc (00:15)
Thanks for inviting me.

New Guest (01:02)
Happy to be here.

Pete Winn (01:10)
Let's begin.`;

describe("publication metadata", () => {
  test("extracts unique diarized speaker labels in appearance order", () => {
    expect(transcriptSpeakerLabels(transcript)).toEqual(["Pete Winn", "dpc", "New Guest"]);
  });

  test("extracts timestamp-first speaker labels used by current transcripts", () => {
    const current = `[00:00:01] Pete\nWelcome.\n\n[00:00:08]\nAndy\nHello.\n\n[00:00:14] Anthony\nThanks.\n\n[00:00:20] Pete\nContinue.`;
    expect(transcriptSpeakerLabels(current)).toEqual(["Pete", "Andy", "Anthony"]);
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
