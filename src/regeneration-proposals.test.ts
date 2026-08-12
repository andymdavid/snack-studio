import { describe, expect, test } from "bun:test";
import { validateRegenerationEvidencePackage } from "./regeneration-proposals.ts";

describe("regeneration evidence provenance", () => {
  const source = [
    { evidenceId: "evidence-17", excerpt: "work through which bits could be code... where do I specifically need the agent" },
    { evidenceId: "evidence-44", excerpt: "I want it to work for twenty people. It doesn't need to scale that big." },
    { evidenceId: "evidence-99", excerpt: "Evidence attached to another Snack." },
  ];

  test("accepts byte-identical evidence already attached to the base Snack", () => {
    expect(() => validateRegenerationEvidencePackage(
      [{ evidenceId: "evidence-44", excerpt: source[1]!.excerpt }],
      source,
      new Set(["evidence-17", "evidence-44"]),
    )).not.toThrow();
  });

  test("rejects altered evidence text", () => {
    expect(() => validateRegenerationEvidencePackage(
      [{ evidenceId: "evidence-17", excerpt: "work through which bits could be code where do I specifically need the agent" }],
      source,
      new Set(["evidence-17"]),
    )).toThrow("changed from the verified source record");
  });

  test("rejects evidence that belongs to another Snack", () => {
    expect(() => validateRegenerationEvidencePackage(
      [{ evidenceId: "evidence-99", excerpt: source[2]!.excerpt }],
      source,
      new Set(["evidence-17"]),
    )).toThrow("was not attached to the base Snack");
  });
});
