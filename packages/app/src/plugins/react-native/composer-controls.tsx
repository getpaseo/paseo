import type {
  ActionProps,
  ComboboxItem,
  ComboboxProps,
  SelectProps,
  ToggleProps,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ComposerControl,
  useComposerControlLocked,
  useComposerControlSurface,
  type ComposerControlItem,
} from "@/composer/agent-controls/composer-control";
import { useComposerLocked } from "@/composer/session";
import { useFetchQuery } from "@/data/query";
import { toErrorMessage } from "@/utils/error-messages";
import { parsePluginIcon, pluginIconComponent } from "../icons";

/** Icons resolve at render, so an invalid one throws to the item's boundary. */
function usePluginControlIcon(icon: ToggleProps["icon"]) {
  return useMemo(() => pluginIconComponent(parsePluginIcon("Composer control", icon)), [icon]);
}

/** Draws one plugin control where its item sits: inline, a row in the sheet, or a field. */
function PluginComposerControl({
  item,
  disabled,
  onOpenChange,
}: {
  item: ComposerControlItem;
  disabled: boolean | undefined;
  onOpenChange?: (open: boolean) => void;
}) {
  const surface = useComposerControlSurface();
  const composerLocked = useComposerLocked();
  const fieldLocked = useComposerControlLocked();
  const locked = composerLocked || fieldLocked;
  const [open, setOpen] = useState(false);
  const handleOpenChange = useMemo(
    () => (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  return (
    <ComposerControl
      item={item}
      surface={surface}
      disabled={disabled || locked}
      open={open}
      onOpenChange={handleOpenChange}
    />
  );
}

export function Toggle({ title, icon, disabled, value, onValueChange }: ToggleProps) {
  const Icon = usePluginControlIcon(icon);
  const item = useMemo<ComposerControlItem>(
    () => ({
      id: "plugin-toggle",
      type: "toggle",
      title,
      icon: Icon,
      highlight: value ? "blue" : undefined,
      value,
      onChange: (next) => onValueChange({ value: next }),
    }),
    [Icon, onValueChange, title, value],
  );
  return <PluginComposerControl item={item} disabled={disabled} />;
}

export function Select<Value extends string>({
  title,
  icon,
  disabled,
  value,
  options,
  onValueChange,
}: SelectProps<Value>) {
  const Icon = usePluginControlIcon(icon);
  const item = useMemo<ComposerControlItem>(
    () => ({
      id: "plugin-select",
      type: "select",
      title,
      icon: Icon,
      value,
      choices: options,
      onChange: (next) => onValueChange({ value: next as Value }),
      showCaret: true,
    }),
    [Icon, onValueChange, options, title, value],
  );
  return <PluginComposerControl item={item} disabled={disabled} />;
}

export function Action({ title, icon, disabled, onPress }: ActionProps) {
  const Icon = usePluginControlIcon(icon);
  const item = useMemo<ComposerControlItem>(
    () => ({ id: "plugin-action", type: "action", title, icon: Icon, onPress: () => onPress({}) }),
    [Icon, onPress, title],
  );
  return <PluginComposerControl item={item} disabled={disabled} />;
}

const SEARCH_DEBOUNCE_MS = 200;
const NO_RESULTS: readonly never[] = [];

/** The query settles after the user stops typing; an empty query applies at once. */
function useDebounced(query: string): string {
  const [settled, setSettled] = useState(query);
  useEffect(() => {
    if (query === "") return setSettled("");
    const timer = setTimeout(() => setSettled(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);
  return settled;
}

/**
 * Searches while the list is open. The search runs once per settled query, keeps the previous
 * results on screen while the next one loads, and drops a search a newer one replaced.
 */
export function Combobox<Item extends ComboboxItem>({
  title,
  icon,
  disabled,
  value,
  search,
  onSelect,
}: ComboboxProps<Item>) {
  const { t } = useTranslation();
  const Icon = usePluginControlIcon(icon);
  const instanceId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const settled = useDebounced(query);
  const results = useFetchQuery({
    queryKey: ["plugin-combobox", instanceId, settled],
    queryFn: () => search({ query: settled }),
    dataShape: "list",
    staleTimeMs: 0,
    enabled: open,
    gcTime: 0,
    retry: false,
  });
  const items: readonly Item[] = results.data ?? NO_RESULTS;
  const item = useMemo<ComposerControlItem>(() => {
    const choices = items.map(({ id, label, description }) => ({ value: id, label, description }));
    return {
      id: "plugin-combobox",
      type: "select",
      title,
      icon: Icon,
      value: value?.id ?? null,
      valueLabel: value?.label,
      choices,
      onChange: (id) => {
        const picked = items.find((candidate) => candidate.id === id);
        return picked ? onSelect({ item: picked }) : undefined;
      },
      searchable: true,
      remoteSearch: true,
      onSearchQueryChange: setQuery,
      emptyText: comboboxEmptyText({ t, results, query, settled }),
      showCaret: true,
    };
  }, [Icon, items, onSelect, query, results, settled, t, title, value]);
  return <PluginComposerControl item={item} disabled={disabled} onOpenChange={setOpen} />;
}

function comboboxEmptyText(input: {
  t: (key: string, options?: Record<string, unknown>) => string;
  results: { isError: boolean; isFetching: boolean; error: unknown };
  query: string;
  settled: string;
}): string {
  const { t, results, query, settled } = input;
  if (results.isError)
    return t("pluginCombobox.failed", { message: toErrorMessage(results.error) });
  if (results.isFetching || query !== settled) return t("pluginCombobox.searching");
  return t("pluginCombobox.empty");
}
