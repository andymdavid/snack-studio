import { describe, expect, test } from "bun:test";
import { validateCandidateRevision, validateReviewDecision } from "./candidate-input.ts";

describe("candidate review input", () => {
  test("accepts supported decisions", () => {
    expect(validateReviewDecision("accepted")).toBe("accepted");
    expect(validateReviewDecision("published")).toBeNull();
  });

  test("normalizes a valid editorial revision", () => {
    const result = validateCandidateRevision({
      publicTitle: "  A claim-shaped title ",
      standfirst: " Clear summary ",
      bodyMarkdown: "## Body",
      primaryTopic: " Technology ",
      relatedTopics: "AI, Software, AI",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.publicTitle).toBe("A claim-shaped title");
      expect(result.value.primaryTopic).toBe("Technology");
      expect(result.value.relatedTopics).toEqual(["AI", "Software"]);
    }
  });

  test("requires the core public fields", () => {
    expect(validateCandidateRevision({ publicTitle: "", standfirst: "Summary", bodyMarkdown: "Body" })).toEqual({
      ok: false,
      error: "publicTitle is required and must be 200 characters or fewer",
    });
  });
});
