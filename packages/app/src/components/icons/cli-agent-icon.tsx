import { Image, type ImageSourcePropType } from "react-native";
import { Asset } from "expo-asset";
import { SvgUri } from "react-native-svg";
import { SquareTerminal } from "lucide-react-native";
import { isWeb } from "@/constants/platform";

interface CliAgentIconProps {
  icon?: string;
  size?: number;
  color?: string;
}

type CliAgentIconAsset = {
  kind: "image" | "svg";
  source: ImageSourcePropType;
};

/* eslint-disable @typescript-eslint/no-require-imports */
const CLI_AGENT_ICON_ASSETS: Record<string, CliAgentIconAsset> = {
  "openai.svg": { kind: "svg", source: require("../../../assets/images/cli-agents/openai.svg") },
  "claude.png": { kind: "image", source: require("../../../assets/images/cli-agents/claude.png") },
  "cursor.svg": { kind: "svg", source: require("../../../assets/images/cli-agents/cursor.svg") },
  "gemini.png": { kind: "image", source: require("../../../assets/images/cli-agents/gemini.png") },
  "qwen.png": { kind: "image", source: require("../../../assets/images/cli-agents/qwen.png") },
  "droid.svg": { kind: "svg", source: require("../../../assets/images/cli-agents/droid.svg") },
  "ampcode.png": {
    kind: "image",
    source: require("../../../assets/images/cli-agents/ampcode.png"),
  },
  "opencode.png": {
    kind: "image",
    source: require("../../../assets/images/cli-agents/opencode.png"),
  },
  "hermesagent.jpg": {
    kind: "image",
    source: require("../../../assets/images/cli-agents/hermesagent.jpg"),
  },
  "gh-copilot.svg": {
    kind: "svg",
    source: require("../../../assets/images/cli-agents/gh-copilot.svg"),
  },
  "charm.png": { kind: "image", source: require("../../../assets/images/cli-agents/charm.png") },
  "Auggie.svg": { kind: "svg", source: require("../../../assets/images/cli-agents/Auggie.svg") },
  "goose.png": { kind: "image", source: require("../../../assets/images/cli-agents/goose.png") },
  "kimi.png": { kind: "image", source: require("../../../assets/images/cli-agents/kimi.png") },
  "kilocode.png": {
    kind: "image",
    source: require("../../../assets/images/cli-agents/kilocode.png"),
  },
  "kiro.png": { kind: "image", source: require("../../../assets/images/cli-agents/kiro.png") },
  "atlassian.png": {
    kind: "image",
    source: require("../../../assets/images/cli-agents/atlassian.png"),
  },
  "cline.png": { kind: "image", source: require("../../../assets/images/cli-agents/cline.png") },
  "continue.png": {
    kind: "image",
    source: require("../../../assets/images/cli-agents/continue.png"),
  },
  "codebuff.png": {
    kind: "image",
    source: require("../../../assets/images/cli-agents/codebuff.png"),
  },
  "mistral.png": {
    kind: "image",
    source: require("../../../assets/images/cli-agents/mistral.png"),
  },
  "pi.png": { kind: "image", source: require("../../../assets/images/cli-agents/pi.png") },
  "autohand.svg": {
    kind: "svg",
    source: require("../../../assets/images/cli-agents/autohand.svg"),
  },
  "forge.svg": { kind: "svg", source: require("../../../assets/images/cli-agents/forge.svg") },
};
/* eslint-enable @typescript-eslint/no-require-imports */

export function CliAgentIcon({ icon, size = 16, color }: CliAgentIconProps) {
  if (!icon) {
    return <SquareTerminal size={size} color={color} />;
  }

  const asset = CLI_AGENT_ICON_ASSETS[icon];
  if (!asset) {
    return <SquareTerminal size={size} color={color} />;
  }

  if (asset.kind === "svg") {
    // On web (RNW), <Image> can render SVG files directly because metro
    // bundles them with an accessible URI — use that path for reliability.
    // `Asset.fromModule(...).uri` has been returning undefined in some cases,
    // which made SVG icons (Codex, Cursor, etc.) fall back to the generic
    // terminal icon.
    if (isWeb) {
      return (
        <Image source={asset.source} style={{ width: size, height: size }} resizeMode="contain" />
      );
    }
    let uri: string | undefined;
    if (typeof asset.source === "string") {
      uri = asset.source;
    } else if (typeof asset.source === "number") {
      uri = Asset.fromModule(asset.source).uri;
    }
    if (!uri) {
      return <SquareTerminal size={size} color={color} />;
    }

    return <SvgUri width={size} height={size} uri={uri} />;
  }

  return (
    <Image
      source={asset.source}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.22) }}
      resizeMode="contain"
    />
  );
}
