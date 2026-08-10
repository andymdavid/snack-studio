import { describe, expect, test } from "bun:test";
import { normalizeTranscriptText, validateEpisodeMetadata, validateTranscriptUpload } from "./transcript-input.ts";

describe("normalizeTranscriptText", () => {
  test("normalizes line endings and surrounding whitespace", () => {
    expect(normalizeTranscriptText("  Speaker: Hello\r\nGuest: Hi\r\n  ")).toEqual({
      ok: true,
      text: "Speaker: Hello\nGuest: Hi",
      sizeBytes: 24,
    });
  });

  test("rejects an empty transcript", () => {
    expect(normalizeTranscriptText(" \n ")).toEqual({ ok: false, error: "transcriptText is required" });
  });
});

describe("validateEpisodeMetadata", () => {
  test("accepts normalized optional metadata", () => {
    expect(validateEpisodeMetadata({
      workingTitle: "  Working title ",
      publicTitle: " Public title ",
      recordedOn: "2026-08-10",
      audioUrl: "https://example.com/audio",
      videoUrl: "",
      editorialNotes: " Notes ",
    })).toEqual({
      ok: true,
      value: {
        episodeNumber: null,
        workingTitle: "Working title",
        publicTitle: "Public title",
        recordedOn: "2026-08-10",
        audioUrl: "https://example.com/audio",
        videoUrl: null,
        editorialNotes: "Notes",
      },
    });
  });

  test("rejects non-http media URLs", () => {
    expect(validateEpisodeMetadata({ workingTitle: "Episode", audioUrl: "file:///private/audio.mp3" })).toEqual({
      ok: false,
      error: "audioUrl must be a valid http(s) URL",
    });
  });
});

describe("validateTranscriptUpload", () => {
  test("accepts a small plain-text file", () => {
    expect(validateTranscriptUpload(new File(["Transcript"], "episode-64.txt", { type: "text/plain" }))).toEqual({ ok: true });
  });

  test("rejects misleading file extensions", () => {
    expect(validateTranscriptUpload(new File(["Transcript"], "episode-64.pdf", { type: "text/plain" }))).toEqual({
      ok: false,
      error: "Transcript uploads must be .txt files",
    });
  });
});
