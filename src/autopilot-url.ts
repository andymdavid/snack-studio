import { WINGMAN_PUBLIC_URL, WINGMAN_URL } from "./config.ts";

function normalize(value: string | null | undefined, fallback: string): string {
  try {
    const url = new URL(value?.trim() || fallback);
    return url.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

function isLoopback(url: URL): boolean {
  return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}

/** Public, canonical URL that must be placed in the NIP-98 `u` tag. */
export function autopilotSigningUrl(value: string | null | undefined): string {
  const target = normalize(value, WINGMAN_URL);
  try {
    const targetUrl = new URL(target);
    if (isLoopback(targetUrl) || targetUrl.origin === new URL(WINGMAN_URL).origin) return WINGMAN_PUBLIC_URL;
  } catch {
    return WINGMAN_PUBLIC_URL;
  }
  return target;
}

/** Network URL used by the Snack Studio server after the public URL is signed. */
export function autopilotTransportUrl(value: string | null | undefined): string {
  const target = normalize(value, WINGMAN_URL);
  try {
    if (new URL(target).origin === new URL(WINGMAN_PUBLIC_URL).origin) return WINGMAN_URL;
  } catch {
    return WINGMAN_URL;
  }
  return target;
}
