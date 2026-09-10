import { Settings } from "lucide-react-native";
import { describe, expect, it } from "vitest";
import { getProviderIcon } from "@/components/provider-icons";
import { replaceProviderSnapshotIcons } from "@/components/provider-icon-name";
import { Icon, ProviderIcon } from "./icons";

describe("Icon", () => {
  it("renders a host Lucide icon with the requested presentation", () => {
    expect(Icon({ name: "Settings", size: 18, color: "#123456" })).toMatchObject({
      type: Settings,
      props: { size: 18, color: "#123456" },
    });
  });

  it("renders nothing for an unknown icon name", () => {
    expect(Icon({ name: "NotALucideIcon" })).toBeNull();
    expect(Icon({ name: "Icon" })).toBeNull();
    expect(Icon({ name: "createLucideIcon" })).toBeNull();
  });
});

describe("ProviderIcon", () => {
  it("renders the provider icon registered by the selected host", () => {
    const svg = '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z" /></svg>';
    replaceProviderSnapshotIcons("server-1", [{ provider: "plugin-provider", iconSvg: svg }]);

    expect(
      ProviderIcon({
        provider: "plugin-provider",
        hostId: "server-1",
        size: 18,
        color: "#123456",
      }),
    ).toMatchObject({
      type: getProviderIcon("plugin-provider", "server-1"),
      props: { size: 18, color: "#123456" },
    });
  });
});
