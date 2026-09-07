import { useEffect, useRef } from "react";
import {
  resolveListSearchKeyAction,
  type ListSearchKeyAction,
  type ListSearchKeyEvent,
} from "@/keyboard/list-search-keys";

export interface ListSearchHandler {
  handlerId: string;
  enabled: boolean;
  priority?: number;
  handle(action: ListSearchKeyAction, event: ListSearchKeyEvent): boolean;
}

type RegisteredListSearchHandler = ListSearchHandler & { registeredAt: number };

export function createListSearchDispatcher() {
  let nextRegistrationOrder = 1;
  const handlers = new Map<string, RegisteredListSearchHandler>();

  return {
    registerHandler(handler: ListSearchHandler) {
      handlers.set(handler.handlerId, { ...handler, registeredAt: nextRegistrationOrder++ });
      return () => {
        handlers.delete(handler.handlerId);
      };
    },

    dispatch(event: ListSearchKeyEvent): boolean {
      const action = resolveListSearchKeyAction(event);
      if (!action) return false;
      const candidates = Array.from(handlers.values())
        .filter((handler) => handler.enabled)
        .sort(
          (left, right) =>
            (right.priority ?? 0) - (left.priority ?? 0) || right.registeredAt - left.registeredAt,
        );
      for (const handler of candidates) {
        if (handler.handle(action, event)) return true;
      }
      return false;
    },
  };
}

export const listSearchDispatcher = createListSearchDispatcher();

let nextHandlerId = 1;

export function useListSearchHandler(input: {
  active: boolean;
  priority?: number;
  handle(action: ListSearchKeyAction, event: ListSearchKeyEvent): boolean;
}): void {
  const handlerIdRef = useRef<string | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;
  if (handlerIdRef.current === null) {
    handlerIdRef.current = `list-search-${nextHandlerId++}`;
  }

  useEffect(() => {
    if (!input.active) return;
    return listSearchDispatcher.registerHandler({
      handlerId: handlerIdRef.current!,
      enabled: true,
      priority: input.priority,
      handle: (action, event) => inputRef.current.handle(action, event),
    });
  }, [input.active, input.priority]);
}
