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

  test("v16 accepts flexible paragraphs and records actual counts without length gates", () => {
    for (const count of [1, 2, 4, 5, 8]) {
      const body = validPipelineCallback();
      body.pipelineVersion = "16";
      const candidate = (body.candidates as Array<Record<string, unknown>>)[0]!;
      candidate.paragraphs = Array.from({ length: count }, () => "Concrete ".repeat(80).trim());
      candidate.wordCount = 1;
      const result = validateSuccessfulPipelineResult(body);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.candidates[0]?.wordCount).toBe(count * 80);
        expect(result.value.candidates[0]?.paragraphCount).toBe(count);
        expect(result.value.candidates[0]?.validationWarnings).toEqual([]);
        expect(result.value.candidates[0]?.structureException).toBeNull();
      }
    }
  });

  test("v16 still requires a nonempty body and keeps evidence validation", () => {
    const body = validPipelineCallback();
    body.pipelineVersion = "16";
    const candidate = (body.candidates as Array<Record<string, unknown>>)[0]!;
    candidate.paragraphs = [];
    expect(validateSuccessfulPipelineResult(body)).toEqual({ ok: false, error: "candidates[0] requires a nonempty body" });
    candidate.paragraphs = [" "];
    expect(validateSuccessfulPipelineResult(body).ok).toBe(false);
    candidate.paragraphs = ["A supported short explanation."];
    (candidate.claimEvidenceMap as Array<Record<string, unknown>>)[0]!.evidenceIds = ["invented"];
    expect(validateSuccessfulPipelineResult(body)).toEqual({ ok: false, error: "candidates[0] references unknown evidence ID invented" });
  });

  test("earlier versions retain their paragraph and word-count contracts", () => {
    for (const version of ["13", "14", "15"]) {
      const body = validPipelineCallback();
      body.pipelineVersion = version;
      const candidate = (body.candidates as Array<Record<string, unknown>>)[0]!;
      candidate.paragraphs = ["One paragraph.", "Two paragraphs."];
      expect(validateSuccessfulPipelineResult(body).ok).toBe(false);
      candidate.paragraphs = Array.from({ length: 3 }, () => "Concrete ".repeat(100).trim());
      expect(validateSuccessfulPipelineResult(body)).toEqual({ ok: false, error: "candidates[0] exceeds 275 words" });
    }
  });
});

test('v16 accepts editorially chosen candidate counts while older contracts keep their limits',()=>{
 for(const count of [1,9]){
  const body=validPipelineCallback();body.pipelineVersion='16';body.promptSuiteVersion='v16-independent-articles';
  const first=(body.candidates as any[])[0];body.candidates=Array.from({length:count},(_,n)=>({...structuredClone(first),selectionId:'idea-'+n}));body.declaredShortfall=null;
  expect(validateSuccessfulPipelineResult(body).ok).toBe(true);
  body.pipelineVersion='15';expect(validateSuccessfulPipelineResult(body).ok).toBe(false);
 }
});

test('v16 stores human review notes as visible per-article warnings without changing prose',()=>{
 const body=validPipelineCallback();body.pipelineVersion='16';body.promptSuiteVersion='v16-independent-articles';const c=(body.candidates as any[])[0];c.reviewNotes=['Source checked; remaining question is editorial.'];
 const result=validateSuccessfulPipelineResult(body);expect(result.ok).toBe(true);if(result.ok){expect(result.value.candidates[0].validationWarnings).toEqual(['Editorial review: Source checked; remaining question is editorial.']);expect(result.value.candidates[0].paragraphs).toEqual(c.paragraphs);}
 c.reviewNotes=Array(21).fill('Too many');expect(validateSuccessfulPipelineResult(body).ok).toBe(false);
});


test("Humanizer punctuation is permitted only for its exact contract", () => {
  const body = validPipelineCallback();
  body.pipelineVersion = "1"; body.promptSuiteVersion = "v13-humanizer-a58df065";
  const c = (body.candidates as Array<Record<string, unknown>>)[0]!;
  c.standfirst = "One condition matters: the app stays usable; the fixes can wait.";
  expect(validateSuccessfulPipelineResult(body).ok).toBe(true);
  body.pipelineVersion = "13";
  expect(validateSuccessfulPipelineResult(body).ok).toBe(false);
  body.pipelineVersion = "1"; body.promptSuiteVersion = "v13-natural-conversational-prose";
  expect(validateSuccessfulPipelineResult(body).ok).toBe(false);
  body.promptSuiteVersion = "v13-humanizer-a58df065"; c.standfirst = "The app stays usable—fixes can wait.";
  expect(validateSuccessfulPipelineResult(body).ok).toBe(false);
});
