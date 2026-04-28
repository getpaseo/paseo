import { Image } from "react-native";

interface HubcodeLogoProps {
  size?: number;
  color?: string;
}

// Full brand logo (994×302, ~3.3:1 aspect ratio)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const logoSource = require("../../../assets/images/hubcode-logo-full.png");
// Square icon logo
// eslint-disable-next-line @typescript-eslint/no-require-imports
const iconSource = require("../../../assets/images/hubcode-icon.png");

const ASPECT_RATIO = 994 / 302;

export function HubcodeLogo({ size = 64 }: HubcodeLogoProps) {
  // When used as a small icon (tool calls, etc.), use the square icon
  if (size <= 32) {
    return <Image source={iconSource} style={{ width: size, height: size }} resizeMode="contain" />;
  }

  // size controls the height; width scales proportionally
  const height = size;
  const width = size * ASPECT_RATIO;

  return <Image source={logoSource} style={{ width, height }} resizeMode="contain" />;
}
