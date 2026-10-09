import { Settings } from "lucide-react-native";
import { describe, expect, it } from "vitest";
import { Icon } from "./icons";

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
