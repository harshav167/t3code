import { describe, expect, it } from "@effect/vitest";

import { resolvePiApprovalLaunch } from "./PiSessionStart.ts";

describe("resolvePiApprovalLaunch", () => {
  it("uses OMP native approval tiers", () => {
    expect(resolvePiApprovalLaunch("/usr/local/bin/omp", "approval-required")).toEqual({
      kind: "omp-native",
      mode: "always-ask",
    });
    expect(resolvePiApprovalLaunch("C:\\tools\\omp.exe", "auto-accept-edits")).toEqual({
      kind: "omp-native",
      mode: "write",
    });
  });

  it("keeps the compatibility extension for Pi and no gate for full access", () => {
    expect(resolvePiApprovalLaunch("/usr/local/bin/pi", "approval-required")).toEqual({
      kind: "pi-extension",
    });
    expect(resolvePiApprovalLaunch("/usr/local/bin/omp", "full-access")).toEqual({
      kind: "none",
    });
  });
});
