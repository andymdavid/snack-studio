import { describe, expect, test } from "bun:test";
// @ts-expect-error Pipeline functions are runtime-loaded JavaScript modules.
import resultContract from "/home/wingman/.wingmen/pipelines/users/swift-zinnia-forge/functions/snack-studio-result-contract.v4.mjs";

const evidence = [{ evidenceId: "evidence-1", excerpt: "Exact evidence", start: null, end: null }];

function candidate(index: number) {
  return {
    selectionId: `selection-0${index}`,
    editorialTitle: `Editorial ${index}`,
    publicTitle: `Public ${index}`,
    standfirst: `Standfirst ${index}`,
    paragraphs: [`First paragraph ${index}.`, `Second paragraph ${index}.`, `Third paragraph ${index}.`],
    structureException: null,
    claimEvidenceMap: [{ claim: `Claim ${index}`, evidenceIds: ["evidence-1"] }],
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    mode: "finalize",
    attemptId: "attempt-1",
    episodeId: "episode-1",
    inputRevisionId: "revision-1",
    pipelineVersion: "11",
    promptSuiteVersion: "v11-webhook-contract-hardened",
    grounding: { evidence },
    selection: { declaredShortfall: null },
    composedResult: { candidates: Array.from({ length: 7 }, (_, index) => candidate(index + 1)), declaredShortfall: null },
    repairedResult: {},
    ...overrides,
  };
}

describe("Snack Studio result contract v4", () => {
  test("merges a partial repair without dropping untouched candidates", async () => {
    const result = await resultContract(input({
      repairedResult: {
        candidates: [{
          selectionId: "selection-03",
          paragraphs: ["Repaired first paragraph.", "Repaired second paragraph.", "Repaired third paragraph."],
        }],
      },
    }));

    expect(result.valid).toBe(true);
    expect(result.result.candidates).toHaveLength(7);
    expect(result.result.candidates[2].publicTitle).toBe("Public 3");
    expect(result.result.candidates[2].paragraphs[0]).toBe("Repaired first paragraph.");
    expect(result.result.candidates[0]).toMatchObject(candidate(1));
  });

  test("fails closed when mode is missing", async () => {
    await expect(resultContract(input({ mode: undefined }))).rejects.toThrow("requires mode validate or finalize");
  });

  test("finalize throws when a repaired result remains invalid", async () => {
    await expect(resultContract(input({
      repairedResult: { candidates: [{ selectionId: "selection-03", paragraphs: ["Still invalid."] }] },
    }))).rejects.toThrow("candidate 3 must have three or four paragraphs");
  });

  test("rejects repairs for candidates outside the composed set", async () => {
    await expect(resultContract(input({
      repairedResult: { candidates: [{ selectionId: "selection-99", paragraphs: ["One.", "Two.", "Three."] }] },
    }))).rejects.toThrow("unknown selection selection-99");
  });

  test("normalizes numeric evidence timestamps to the webhook schema", async () => {
    const result = await resultContract(input({
      grounding: { evidence: [{ evidenceId: "evidence-1", excerpt: "Exact evidence", start: 19.823, end: 21 }] },
    }));

    expect(result.result.evidence[0]).toMatchObject({ start: "19.823", end: "21" });
  });
});
