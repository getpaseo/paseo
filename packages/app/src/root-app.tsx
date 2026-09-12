import { useCallback, useState, type ComponentProps } from "react";
import { ExpoRoot } from "expo-router";
import Head from "expo-router/head";
import { QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { queryClient } from "@/data/query-client";
import { I18nProvider } from "@/i18n/provider";
import { RootErrorBoundary } from "@/components/root-error-boundary";

// Keep Expo's platform filtering, route root, and lazy import configuration.
const { ctx: context } = require("expo-router/_ctx") as {
  ctx: ComponentProps<typeof ExpoRoot>["context"];
};

export function RootApp() {
  return <RootRouter context={context} />;
}

export function RootRouter({ context: routes }: Pick<ComponentProps<typeof ExpoRoot>, "context">) {
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);

  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <SafeAreaProvider>
          <RootErrorBoundary key={generation} onReload={reload}>
            <Head.Provider>
              {/* Recreate the router at a safe destination before a failed route can mount. */}
              <ExpoRoot
                context={routes}
                location={generation === 0 ? undefined : "/open-project"}
              />
            </Head.Provider>
          </RootErrorBoundary>
        </SafeAreaProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}
