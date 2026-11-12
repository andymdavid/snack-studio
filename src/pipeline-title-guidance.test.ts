import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const definitionPath = "/home/wingman/.wingmen/pipelines/users/swift-zinnia-forge/definitions/snack-studio-transcript-to-snacks.v13.json";
const standardPath = "/home/wingman/.wingmen/pipelines/shared/standards/intelligence-snack-editorial-standard.v3.md";

describe("transcript-to-snacks title guidance", () => {
  test("keeps descriptive title requirements in composition and review", () => {
    const definition = JSON.parse(readFileSync(definitionPath, "utf8"));
    const compose = definition.steps.find((step: { id: string }) => step.id === "compose-snacks-independently");
    const diagnose = definition.steps.find((step: { id: string }) => step.id === "diagnose-editorial-issues");
    const finalEdit = definition.steps.find((step: { id: string }) => step.id === "edit-final-snacks-once");

    expect(definition).toMatchObject({ version: 13, input: { pipelineVersion: "13", promptSuiteVersion: "v13-natural-conversational-prose" } });
    expect(compose.step.prompt).toContain("usually in five to eight words");
    expect(compose.step.prompt).toContain("concrete subject");
    expect(diagnose.prompt).toContain("work without its standfirst");
    expect(diagnose.prompt).toContain("repeated constructions");
    expect(finalEdit.step.prompt).toContain("intelligence-snack-editorial-standard.v3.md");
  });

  test("the frozen standard balances search language with source fidelity", () => {
    const standard = readFileSync(standardPath, "utf8");
    expect(standard).toContain("Usually use five to eight words");
    expect(standard).toContain("concrete subject");
    expect(standard).toContain("Never add a popular term merely for SEO");
    expect(standard).toContain("understandable without its standfirst");
    expect(standard).toContain("Prefer ordinary conversational contractions");
    expect(standard).toContain("Keep the expanded form when it carries deliberate emphasis");
    expect(standard).toContain("Never alter a direct quotation");
  });
});
