import { describe, expect, test } from "bun:test";
import { validateEpisodeInput } from "./episode-input.ts";

describe("validateEpisodeInput", () => {
  test("normalizes a valid numbered episode", () => {
    expect(validateEpisodeInput({ episodeNumber: "64", workingTitle: "  Agent harnesses  " })).toEqual({
      ok: true,
      value: { episodeNumber: 64, workingTitle: "Agent harnesses" },
    });
  });

  test("allows an episode number to be assigned later", () => {
    expect(validateEpisodeInput({ episodeNumber: "", workingTitle: "Working conversation" })).toEqual({
      ok: true,
      value: { episodeNumber: null, workingTitle: "Working conversation" },
    });
  });

  test("rejects missing titles and invalid episode numbers", () => {
    expect(validateEpisodeInput({ workingTitle: " " })).toEqual({ ok: false, error: "workingTitle is required" });
    expect(validateEpisodeInput({ episodeNumber: 1.5, workingTitle: "Fractional" })).toEqual({
      ok: false,
      error: "episodeNumber must be a positive whole number",
    });
  });
});
