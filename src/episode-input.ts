export type ValidEpisodeInput = {
  episodeNumber: number | null;
  workingTitle: string;
};

export function validateEpisodeInput(body: Record<string, unknown>):
  | { ok: true; value: ValidEpisodeInput }
  | { ok: false; error: string } {
  const workingTitle = typeof body.workingTitle === "string" ? body.workingTitle.trim() : "";
  const rawEpisodeNumber = body.episodeNumber;
  const episodeNumber = rawEpisodeNumber === null || rawEpisodeNumber === undefined || rawEpisodeNumber === ""
    ? null
    : Number(rawEpisodeNumber);

  if (!workingTitle) return { ok: false, error: "workingTitle is required" };
  if (workingTitle.length > 160) return { ok: false, error: "workingTitle must be 160 characters or fewer" };
  if (episodeNumber !== null && (!Number.isInteger(episodeNumber) || episodeNumber < 1)) {
    return { ok: false, error: "episodeNumber must be a positive whole number" };
  }
  return { ok: true, value: { episodeNumber, workingTitle } };
}
