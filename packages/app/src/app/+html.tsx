import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";

// Ensure Unistyles runs before Expo Router statically renders each page.
import "../styles/unistyles";

const webEcosystemStyles = /* css */ `
  html {
    touch-action: auto;
  }

  body {
    overflow: auto;
    overscroll-behavior: contain;
    -webkit-user-select: text;
    user-select: text;
  }

  body * {
    -webkit-user-select: text;
    user-select: text;
  }
`;

function WebRespectfulStyleReset() {
  return (
    <style
      id="paseo-web-ecosystem"
      dangerouslySetInnerHTML={{ __html: webEcosystemStyles }}
    />
  );
}

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no, user-scalable=yes, minimum-scale=1, maximum-scale=5"
        />
        {/* Reset scroll styles so React Native Web views behave like native. */}
        <ScrollViewStyleReset />
        <WebRespectfulStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}
