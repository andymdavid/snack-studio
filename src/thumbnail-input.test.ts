import { describe, expect, test } from "bun:test";
import { validateThumbnailBrief } from "./thumbnail-input.ts";

describe("thumbnail brief input", () => {
  test("normalizes a grounded Snack thumbnail brief", () => {
    expect(validateThumbnailBrief({
      assetKind: "snack",
      snackCandidateId: "snack-64-1",
      topicColour: "#FE7141",
      contributorIds: ["andy-david", "pete-winn", "andy-david"],
      reviewNotes: " Keep the hand planes prominent. ",
    })).toEqual({
      assetKind: "snack",
      snackCandidateId: "snack-64-1",
      topicColour: "#fe7141",
      contributorIds: ["andy-david", "pete-winn"],
      reviewNotes: "Keep the hand planes prominent.",
    });
  });

  test("keeps episode briefs independent of Snack-only fields", () => {
    expect(validateThumbnailBrief({
      assetKind: "episode",
      contributorIds: ["pete-winn"],
      topicColour: null,
    })).toMatchObject({ assetKind: "episode", snackCandidateId: null, topicColour: null });
  });

  test("rejects an ungrounded Snack brief", () => {
    expect(() => validateThumbnailBrief({
      assetKind: "snack",
      snackCandidateId: "snack-1",
      topicColour: "orange",
      contributorIds: [],
    })).toThrow("six-digit topic colour");
  });
});
