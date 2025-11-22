import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";

// Ensure Unistyles runs before Expo Router statically renders each page.
import "../styles/unistyles";

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no"
        />
        {/* Reset scroll styles so React Native Web views behave like native. */}
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}
