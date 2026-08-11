import { THUMBNAIL_CONTRIBUTORS } from "./thumbnail-catalog.ts";

export type ThumbnailAssetKind = "snack" | "episode";

export type ThumbnailBriefInput = {
  assetKind: ThumbnailAssetKind;
  snackCandidateId: string | null;
  topicColour: string | null;
  contributorIds: string[];
  reviewNotes: string | null;
};

const HEX_COLOUR = /^#[0-9a-f]{6}$/i;
const CONTRIBUTOR_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const APPROVED_CONTRIBUTORS = new Set<string>(THUMBNAIL_CONTRIBUTORS.map(({ id }) => id));

function optionalText(value: unknown, maxLength: number): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error("Expected text");
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) throw new Error(`Text must be ${maxLength} characters or fewer`);
  return normalized;
}

export function validateThumbnailBrief(value: Record<string, unknown>): ThumbnailBriefInput {
  if (value.assetKind !== "snack" && value.assetKind !== "episode") {
    throw new Error("Thumbnail type must be snack or episode");
  }
  const assetKind = value.assetKind;
  const snackCandidateId = optionalText(value.snackCandidateId, 100);
  if (assetKind === "snack" && !snackCandidateId) throw new Error("Snack thumbnails require a Snack candidate");
  if (assetKind === "episode" && snackCandidateId) throw new Error("Episode thumbnails cannot target a Snack candidate");

  const topicColour = optionalText(value.topicColour, 7);
  if (assetKind === "snack" && (!topicColour || !HEX_COLOUR.test(topicColour))) {
    throw new Error("Snack thumbnails require a six-digit topic colour");
  }
  if (topicColour && !HEX_COLOUR.test(topicColour)) throw new Error("Topic colour must use #RRGGBB format");

  if (!Array.isArray(value.contributorIds)) throw new Error("Contributors must be a list");
  const contributorIds = [...new Set(value.contributorIds.map((item) => {
    if (typeof item !== "string" || !CONTRIBUTOR_ID.test(item.trim())) throw new Error("Contributor IDs must use lowercase slugs");
    return item.trim();
  }))];
  if (!contributorIds.length) throw new Error("Select at least one contributor");
  if (contributorIds.length > 6) throw new Error("Select no more than six contributors");
  if (contributorIds.some((id) => !APPROVED_CONTRIBUTORS.has(id))) {
    throw new Error("Every contributor requires an approved thumbnail reference");
  }

  return {
    assetKind,
    snackCandidateId,
    topicColour: topicColour?.toLowerCase() || null,
    contributorIds,
    reviewNotes: optionalText(value.reviewNotes, 2000),
  };
}
