/** @vitest-environment jsdom */
import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useDesktopOpenTargets } from "./desktop-open-targets";

const cachedTargets = [
  {
    id: "vscode",
    label: "VS Code",
    kind: "editor" as const,
    icon: { kind: "symbol" as const, name: "terminal" as const },
  },
];

afterEach(() => {
  window.paseoDesktop = undefined;
});

describe("useDesktopOpenTargets", () => {
  it("hides cached targets when local execution is unavailable", () => {
    window.paseoDesktop = {
      editor: {
        listTargets: async () => cachedTargets,
        openTarget: async () => {},
      },
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["desktop-open-targets"], cachedTargets);
    function wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    }

    const { result } = renderHook(() => useDesktopOpenTargets({ isLocalExecution: false }), {
      wrapper,
    });

    expect(result.current.targets).toEqual([]);
    expect(queryClient.getQueryData(["desktop-open-targets"])).toEqual(cachedTargets);
  });
});
