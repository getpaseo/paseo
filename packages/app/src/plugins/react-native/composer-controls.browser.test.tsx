import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComboboxItem } from "@getpaseo/plugin/client/ui";
import type { ToastApi } from "@/components/toast-host";
import { ComposerControlSurfaceProvider } from "@/composer/agent-controls/composer-control";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { i18n } from "@/i18n/i18next";
import { Combobox } from "./composer-controls";

beforeEach(async () => {
  vi.stubGlobal("React", React);
  await i18n.changeLanguage("en");
});
afterEach(cleanup);

interface Issue extends ComboboxItem {
  branch: string;
}

const ONE: Issue = { id: "1", label: "Slow sidebar", branch: "one" };
const TWO: Issue = { id: "2", label: "Crash on resume", branch: "two" };

interface Search {
  query: string;
  resolve(items: Issue[]): void;
  reject(error: Error): void;
}

/** A search the test settles by hand, so it decides which one finishes first. */
function controlledSearch() {
  const searches: Search[] = [];
  const search = ({ query }: { query: string }) =>
    new Promise<Issue[]>((resolve, reject) => {
      searches.push({ query, resolve, reject });
    });
  const forQuery = (query: string) => {
    const found = searches.find((candidate) => candidate.query === query);
    if (!found) throw new Error(`No search for "${query}" yet`);
    return found;
  };
  return { search, forQuery, queries: () => searches.map((candidate) => candidate.query) };
}

const toast = { error: vi.fn() } as unknown as ToastApi;
const ignoreSelect = () => undefined;

function Harness({
  search,
  value,
  onSelect = ignoreSelect,
}: {
  search: (event: { query: string }) => Promise<Issue[]>;
  value: ComboboxItem | null;
  onSelect?: (event: { item: Issue }) => void;
}) {
  const [queryClient] = React.useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <ToastApiProvider api={toast}>
        <ComposerControlSurfaceProvider value="field">
          <Combobox
            title="Issue"
            icon="CircleDot"
            value={value}
            search={search}
            onSelect={onSelect}
          />
        </ComposerControlSurfaceProvider>
      </ToastApiProvider>
    </QueryClientProvider>
  );
}

function renderCombobox(input: {
  search: (event: { query: string }) => Promise<Issue[]>;
  value?: ComboboxItem | null;
  onSelect?: (event: { item: Issue }) => void;
}) {
  render(<Harness search={input.search} value={input.value ?? null} onSelect={input.onSelect} />);
  fireEvent.click(screen.getByRole("button", { name: "Issue" }));
}

describe("plugin Combobox", () => {
  it("searches when the list opens, shows the results, and hands the picked item back", async () => {
    const controlled = controlledSearch();
    const onSelect = vi.fn();
    renderCombobox({ search: controlled.search, onSelect });

    await waitFor(() => expect(controlled.queries()).toEqual([""]));
    expect(screen.getByText("Searching…")).toBeTruthy();
    controlled.forQuery("").resolve([ONE, TWO]);

    fireEvent.click(await screen.findByText("Crash on resume"));
    expect(onSelect).toHaveBeenCalledWith({ item: TWO });
  });

  it("shows the error and not stale results when the search fails", async () => {
    const controlled = controlledSearch();
    renderCombobox({ search: controlled.search });

    await waitFor(() => expect(controlled.queries()).toEqual([""]));
    controlled.forQuery("").reject(new Error("tracker is down"));

    expect(await screen.findByText("Search failed: tracker is down")).toBeTruthy();
  });

  it("keeps the previous results while a newer search runs and ignores a superseded one", async () => {
    const controlled = controlledSearch();
    renderCombobox({ search: controlled.search });
    await waitFor(() => expect(controlled.queries()).toEqual([""]));
    controlled.forQuery("").resolve([ONE, TWO]);
    await screen.findByText("Slow sidebar");

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "c" } });
    await waitFor(() => expect(controlled.queries()).toEqual(["", "c"]));
    expect(screen.getByText("Slow sidebar")).toBeTruthy();

    fireEvent.change(input, { target: { value: "cr" } });
    await waitFor(() => expect(controlled.queries()).toEqual(["", "c", "cr"]));
    controlled.forQuery("cr").resolve([TWO]);
    await waitFor(() => expect(screen.queryByText("Slow sidebar")).toBeNull());
    controlled.forQuery("c").resolve([ONE]);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText("Crash on resume")).toBeTruthy();
    expect(screen.queryByText("Slow sidebar")).toBeNull();
  });

  it("shows a chosen value that the search no longer returns", async () => {
    const controlled = controlledSearch();
    renderCombobox({ search: controlled.search, value: { id: "9", label: "PAS-9 Old issue" } });

    expect(screen.getByRole("button", { name: "Issue" }).textContent).toContain("PAS-9 Old issue");
    await waitFor(() => expect(controlled.queries()).toEqual([""]));
    controlled.forQuery("").resolve([ONE]);
    await screen.findByText("Slow sidebar");
    expect(screen.getByRole("button", { name: "Issue" }).textContent).toContain("PAS-9 Old issue");
  });
});
