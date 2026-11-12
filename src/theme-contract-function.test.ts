import { describe, expect, test } from "bun:test";
// @ts-expect-error Pipeline functions are runtime-loaded JavaScript modules.
import buildEvidence from "/home/wingman/.wingmen/pipelines/users/swift-zinnia-forge/functions/snack-studio-theme-evidence-catalog.v1.mjs";
// @ts-expect-error Pipeline functions are runtime-loaded JavaScript modules.
import finalizeTheme from "/home/wingman/.wingmen/pipelines/users/swift-zinnia-forge/functions/snack-studio-theme-contract.v2.mjs";

describe("publication theme pipeline contract", () => {
  test("resolves selected evidence IDs to byte-exact transcript text", async () => {
    const transcript = "Pete\n00:01\nAgents can coordinate work across several software systems.\n\nAndy\n00:08\nThe workflow remains visible to the operator.";
    const evidenceCatalog = await buildEvidence({ transcript });
    const selected = evidenceCatalog.evidence[0];
    const result = await finalizeTheme({
      requestId: "request-1", attemptId: "attempt-1", episodeId: "episode-1",
      inputRevisionId: "revision-1", resultSchemaVersion: "2", pipelineVersion: "5",
      evidenceCatalog,
      themeRegistry: [{ id: "agents", name: "Agents", description: "Agent systems and workflows." }],
      approvedCandidates: [{ candidateId: "candidate-1", revisionId: "snack-revision-1" }],
      classification: {
        episodeThemes: [{ existingThemeId: "agents", evidenceId: selected.evidenceId, rationale: "The episode discusses agent coordination." }],
        snackAssignments: [{ candidateId: "candidate-1", revisionId: "snack-revision-1", themeKey: "agents", rationale: "The Snack concerns agent coordination." }],
      },
    });

    expect(result.episodeThemes[0].evidenceExcerpt).toBe(selected.excerpt);
    expect(transcript.includes(result.episodeThemes[0].evidenceExcerpt)).toBeTrue();
  });

  test("rejects invented evidence IDs before webhook delivery", async () => {
    await expect(finalizeTheme({
      requestId: "request-1", attemptId: "attempt-1", episodeId: "episode-1",
      inputRevisionId: "revision-1", resultSchemaVersion: "2", pipelineVersion: "5",
      evidenceCatalog: { evidence: [{ evidenceId: "known", excerpt: "Exact transcript evidence." }] },
      themeRegistry: [{ id: "agents", name: "Agents", description: "Agent systems." }],
      approvedCandidates: [{ candidateId: "candidate-1", revisionId: "revision-1" }],
      classification: {
        episodeThemes: [{ existingThemeId: "agents", evidenceId: "invented", rationale: "Relevant." }],
        snackAssignments: [{ candidateId: "candidate-1", revisionId: "revision-1", themeKey: "agents", rationale: "Relevant." }],
      },
    })).rejects.toThrow("must select a catalogue evidenceId");
  });
});
