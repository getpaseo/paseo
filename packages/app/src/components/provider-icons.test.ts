import { describe, expect, it, vi } from "vitest";

vi.mock("lucide-react-native", () => ({
  Bot: function Bot() {
    return null;
  },
  PackagePlus: function PackagePlus() {
    return null;
  },
}));

import { Bot, PackagePlus } from "lucide-react-native";
import { getProviderIcon } from "./provider-icons";

describe("getProviderIcon", () => {
  it("keeps built-in provider icons", () => {
    expect(getProviderIcon("kiro")).toBe(PackagePlus);
  });

  it("uses vendored ACP catalog icons for catalog provider ids", () => {
    const icon = getProviderIcon("amp-acp");

    expect(icon).not.toBe(Bot);
    expect(getProviderIcon("amp-acp")).toBe(icon);
  });

  it("falls back to the robot icon for unknown custom providers", () => {
    expect(getProviderIcon("custom-claude-profile")).toBe(Bot);
  });
});
