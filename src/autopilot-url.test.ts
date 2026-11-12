import { describe, expect, test } from "bun:test";
import { autopilotSigningUrl, autopilotTransportUrl } from "./autopilot-url.ts";
import { WINGMAN_PUBLIC_URL, WINGMAN_URL } from "./config.ts";

describe("Autopilot NIP-98 URLs", () => {
  test("signs the public origin while transporting over loopback", () => {
    expect(autopilotSigningUrl(WINGMAN_URL)).toBe(WINGMAN_PUBLIC_URL);
    expect(autopilotTransportUrl(WINGMAN_PUBLIC_URL)).toBe(WINGMAN_URL);
  });

  test("leaves an unrelated remote Autopilot target unchanged", () => {
    expect(autopilotSigningUrl("https://autopilot.example/")).toBe("https://autopilot.example");
    expect(autopilotTransportUrl("https://autopilot.example/")).toBe("https://autopilot.example");
  });
});
