import * as React from "react";

const MOBILE_USER_AGENT_PATTERN = /android|iphone|ipad|ipod|mobile/i;

export function releaseBase(version: string) {
  return `https://github.com/getpaseo/paseo/releases/download/v${version}`;
}

export function downloadUrls(version: string) {
  const base = releaseBase(version);
  return {
    macAppleSilicon: `${base}/Paseo-${version}-arm64.dmg`,
    macIntel: `${base}/Paseo-${version}-x64.dmg`,
  };
}

export const webAppUrl = "https://app.paseo.sh";

type Platform = "mac-silicon" | "mac-intel" | "web";

export interface DownloadOption {
  platform: Platform;
  label: string;
  href: string;
  icon: (props: React.SVGProps<SVGSVGElement>) => React.ReactElement;
}

export function getDownloadOptions(version: string): DownloadOption[] {
  const urls = downloadUrls(version);
  return [
    {
      platform: "mac-silicon",
      label: "Mac",
      href: urls.macAppleSilicon,
      icon: AppleIcon,
    },
    {
      platform: "mac-intel",
      label: "Mac Intel",
      href: urls.macIntel,
      icon: AppleIcon,
    },
    {
      platform: "web",
      label: "Web",
      href: webAppUrl,
      icon: GlobeIcon,
    },
  ];
}

export function useDetectedPlatform(): Platform {
  const [platform, setPlatform] = React.useState<Platform>("mac-silicon");

  React.useEffect(() => {
    const ua = navigator.userAgent.toLowerCase();
    const isTouchMac = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;

    if (MOBILE_USER_AGENT_PATTERN.test(ua) || isTouchMac) {
      setPlatform("web");
      return;
    }

    if (ua.includes("mac")) {
      const isARM =
        /arm|aarch64/i.test(navigator.platform) ||
        (navigator as unknown as { userAgentData?: { architecture?: string } }).userAgentData
          ?.architecture === "arm";
      setPlatform(isARM ? "mac-silicon" : "mac-intel");
      return;
    }

    setPlatform("web");
  }, []);

  return platform;
}

export function AppleIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
    </svg>
  );
}

export function TerminalIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </svg>
  );
}

export function GlobeIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a15 15 0 0 1 0 18" />
      <path d="M12 3a15 15 0 0 0 0 18" />
    </svg>
  );
}
