import { Image } from "react-native";

interface HubcodeLogoProps {
  size?: number;
  color?: string;
}

// Full brand logo (994×302, ~3.3:1 aspect ratio)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const logoSource = require("../../../assets/images/hubcode-logo-full.png");

const ASPECT_RATIO = 994 / 302;

export function HubcodeLogo({ size = 64 }: HubcodeLogoProps) {
  // size controls the height; width scales proportionally
  const height = size;
  const width = size * ASPECT_RATIO;

  return (
    <Image
      source={logoSource}
      style={{ width, height }}
      resizeMode="contain"
    />
  );
}
