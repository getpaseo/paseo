import { useCallback, useEffect, useState } from "react";
import {
  getAutocompleteFallbackIndex,
  getAutocompleteNextIndex,
  type AutocompleteOptionsPosition,
} from "@/components/ui/autocomplete-utils";

interface AutocompleteKeyPressEvent {
  key: string;
  preventDefault: () => void;
}

interface UseAutocompleteInput<
  TOption,
  TKeyPressEvent extends AutocompleteKeyPressEvent = AutocompleteKeyPressEvent,
> {
  isVisible: boolean;
  options: readonly TOption[];
  query: string;
  onSelectOption: (option: TOption, event?: TKeyPressEvent) => void;
  onEscape?: () => void;
  optionsPosition?: AutocompleteOptionsPosition;
}

interface UseAutocompleteResult<TKeyPressEvent extends AutocompleteKeyPressEvent> {
  selectedIndex: number;
  onKeyPress: (event: TKeyPressEvent) => boolean;
}

export function useAutocomplete<
  TOption,
  TKeyPressEvent extends AutocompleteKeyPressEvent = AutocompleteKeyPressEvent,
>(input: UseAutocompleteInput<TOption, TKeyPressEvent>): UseAutocompleteResult<TKeyPressEvent> {
  // The user's choice, tied to the query it was made for. The shown index is resolved from it
  // during render, so a list never paints its first frame without a selection: the popover only
  // measures once a non-empty list has one.
  const [choice, setChoice] = useState<{ index: number; query: string } | null>(null);
  const itemCount = input.isVisible ? input.options.length : 0;
  const selectedIndex = resolveSelectedIndex({
    choice,
    query: input.query,
    itemCount,
    optionsPosition: input.optionsPosition,
  });

  // A choice belongs to one search. Until this clears it, the query check above ignores it.
  useEffect(() => {
    setChoice(null);
  }, [input.isVisible, input.query]);

  const onKeyPress = useCallback(
    (event: TKeyPressEvent) => {
      if (!input.isVisible || input.options.length === 0) {
        return false;
      }

      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        setChoice({
          index: getAutocompleteNextIndex({
            currentIndex: selectedIndex,
            itemCount: input.options.length,
            key: event.key,
          }),
          query: input.query,
        });
        return true;
      }

      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        const selectedOption = input.options[selectedIndex];
        if (selectedOption) {
          input.onSelectOption(selectedOption, event);
        }
        return true;
      }

      if (event.key === "Escape" && input.onEscape) {
        event.preventDefault();
        input.onEscape();
        return true;
      }

      return false;
    },
    [input, selectedIndex],
  );

  return {
    selectedIndex,
    onKeyPress,
  };
}

function resolveSelectedIndex(input: {
  choice: { index: number; query: string } | null;
  query: string;
  itemCount: number;
  optionsPosition?: AutocompleteOptionsPosition;
}): number {
  const { choice } = input;
  if (
    choice &&
    choice.query === input.query &&
    choice.index >= 0 &&
    choice.index < input.itemCount
  ) {
    return choice.index;
  }
  return getAutocompleteFallbackIndex(input.itemCount, input.optionsPosition);
}
