/** @vitest-environment jsdom */
import React from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it } from "vitest";
import type { AppSettings } from "@/hooks/use-settings";
import { AppearanceProvider } from "./provider";

it("does not mount screen content while initial appearance is still loading", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const loading = client
    .fetchQuery({
      queryKey: ["app-settings"],
      queryFn: () => new Promise<AppSettings>(() => {}),
    })
    .catch(() => undefined);
  const view = render(
    <QueryClientProvider client={client}>
      <AppearanceProvider>
        <div data-testid="workspace">Reconnecting to host</div>
      </AppearanceProvider>
    </QueryClientProvider>,
  );
  try {
    expect(view.queryByTestId("workspace")).toBeNull();
  } finally {
    view.unmount();
    await client.cancelQueries();
    await loading;
    client.clear();
  }
});
