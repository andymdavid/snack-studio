function secureExternalOrigin(origin: URL): string {
  if (origin.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(origin.hostname)) {
    origin.protocol = "https:";
  }
  return origin.origin;
}

export function publicRequestOrigin(req: Request, configuredOrigin = ""): string {
  if (configuredOrigin.trim()) return secureExternalOrigin(new URL(configuredOrigin));

  const origin = new URL(req.url);
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase();
  if (forwardedProto === "http" || forwardedProto === "https") origin.protocol = `${forwardedProto}:`;
  return secureExternalOrigin(origin);
}
