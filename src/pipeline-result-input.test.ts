import { describe, expect, test } from "bun:test";
import { validateSuccessfulPipelineResult } from "./pipeline-result-input.ts";
import { validPipelineCallback } from "./pipeline-result-fixture.ts";

describe("transcript-to-snacks callback validation", () => {
  test("normalizes a supported six-candidate result", () => {
    const result = validateSuccessfulPipelineResult(validPipelineCallback());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.candidates).toHaveLength(6);
      expect(result.value.candidates[0]?.validationWarnings).toContain("Body contains fewer than approximately 140 words");
    }
  });

  test("allows four paragraphs only with a visible structural reason", () => {
    const body = validPipelineCallback();
    const candidate = (body.candidates as Array<Record<string, unknown>>)[0]!;
    candidate.paragraphs = [...candidate.paragraphs as string[], "A fourth paragraph performs a distinct explanatory job."];
    expect(validateSuccessfulPipelineResult(body)).toEqual({ ok: false, error: "candidates[0] requires structureException for four paragraphs" });
    candidate.structureException = "The final boundary needs a distinct paragraph.";
    const valid = validateSuccessfulPipelineResult(body);
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.value.candidates[0]?.validationWarnings[0]).toContain("Four-paragraph structure");
  });

  test("rejects unsupported evidence and mechanical editorial violations", () => {
    const unknownEvidence = validPipelineCallback();
    ((unknownEvidence.candidates as Array<Record<string, unknown>>)[0]!.claimEvidenceMap as Array<Record<string, unknown>>)[0]!.evidenceIds = ["invented"];
    expect(validateSuccessfulPipelineResult(unknownEvidence)).toEqual({ ok: false, error: "candidates[0] references unknown evidence ID invented" });

    const punctuation = validPipelineCallback();
    (punctuation.candidates as Array<Record<string, unknown>>)[0]!.standfirst = "An unsupported pattern: a colon.";
    expect(validateSuccessfulPipelineResult(punctuation)).toEqual({ ok: false, error: "candidates[0].standfirst contains prohibited punctuation" });
  });

  test("requires an explicit reason for a short candidate set", () => {
    const body = validPipelineCallback(5);
    expect(validateSuccessfulPipelineResult(body)).toEqual({ ok: false, error: "fewer than six candidates requires declaredShortfall" });
    body.declaredShortfall = { reason: "Only five ideas passed the grounding review." };
    expect(validateSuccessfulPipelineResult(body).ok).toBe(true);
  });
});
