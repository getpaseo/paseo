import { describe, expect, it, vi } from "vitest";
import { Bot, Shield } from "lucide-react-native";
import { getCommandCenterIcon } from "./icon";

vi.mock("lucide-react-native", () => ({
  Bot: function MockBot() {
    return null;
  },
  Shield: function MockShield() {
    return null;
  },
}));

describe("getCommandCenterIcon", () => {
  it("caches the muted adapter by raw icon component", () => {
    expect(getCommandCenterIcon(Bot)).toBe(getCommandCenterIcon(Bot));
    expect(getCommandCenterIcon(Bot)).not.toBe(getCommandCenterIcon(Shield));
  });
});
