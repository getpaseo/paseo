import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import {
  callPluginRpc,
  subscribePluginRpc,
  type PluginRpcContract,
  type PluginSubscriptionContract,
  type PluginSubscriptionHandle,
  type PluginSubscriptionObserver,
  type PluginWireInput,
} from "../rpc.js";
import { shallowEqual } from "./shallow.js";

export type PluginSubscribe = (
  method: string,
  input: unknown,
  observer: PluginSubscriptionObserver,
) => PluginSubscriptionHandle;

export interface PluginRpcContextValue {
  invoke(method: string, input: unknown): Promise<unknown>;
  subscribe: PluginSubscribe;
}

const PluginRpcContext = createContext<PluginRpcContextValue | null>(null);

export function usePluginRpcContextValue(): PluginRpcContextValue | null {
  return useContext(PluginRpcContext);
}

export function PluginRpcProvider({
  children,
  invoke,
  subscribe,
}: {
  children: ReactNode;
  invoke(method: string, input: unknown): Promise<unknown>;
  subscribe: PluginSubscribe;
}) {
  const value = useMemo(() => ({ invoke, subscribe }), [invoke, subscribe]);
  return <PluginRpcContext.Provider value={value}>{children}</PluginRpcContext.Provider>;
}

export function useRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
  contract: PluginRpcContract<InputSchema, OutputSchema>,
): (input: PluginWireInput<ZodInput<InputSchema>>) => Promise<ZodOutput<OutputSchema>> {
  const context = usePluginRpcContextValue();
  if (!context) throw new Error("useRpc must run inside a contributed plugin surface");

  return useCallback(
    (input: PluginWireInput<ZodInput<InputSchema>>) =>
      callPluginRpc(contract, context.invoke, input),
    [context, contract],
  );
}

export type PluginSubscriptionState =
  | { status: "connecting" }
  | { status: "live" }
  /** The plugin's handler finished. The hook subscribes again when `input` changes. */
  | { status: "closed" }
  | { status: "error"; error: Error };

/**
 * Subscribes while the component is mounted. Re-subscribes when `input` changes by shallow
 * comparison; `onEvent` always runs the latest callback.
 */
export function useSubscription<InputSchema extends ZodType, EventSchema extends ZodType>(
  contract: PluginSubscriptionContract<InputSchema, EventSchema>,
  input: PluginWireInput<ZodInput<InputSchema>>,
  onEvent: (event: ZodOutput<EventSchema>) => void,
): PluginSubscriptionState {
  const context = usePluginRpcContextValue();
  if (!context) throw new Error("useSubscription must run inside a contributed plugin surface");
  const subscribe = context.subscribe;
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const stableInput = useShallowStable(input);
  const [state, setState] = useState<PluginSubscriptionState>({ status: "connecting" });

  useEffect(() => {
    let active = true;
    setState({ status: "connecting" });
    let handle: PluginSubscriptionHandle;
    try {
      handle = subscribePluginRpc(
        contract,
        subscribe,
        stableInput,
        (event) => onEventRef.current(event),
        {
          onClosed: ({ error }) => {
            if (active) setState(error ? { status: "error", error } : CLOSED);
          },
        },
      );
    } catch (error) {
      setState({ status: "error", error: toError(error) });
      return;
    }
    handle.ready.then(
      () => {
        if (active) setState((current) => (current.status === "connecting" ? LIVE : current));
        return undefined;
      },
      (error: unknown) => {
        if (active) setState({ status: "error", error: toError(error) });
      },
    );
    return () => {
      active = false;
      handle();
    };
  }, [contract, subscribe, stableInput]);

  return state;
}

const LIVE: PluginSubscriptionState = { status: "live" };
const CLOSED: PluginSubscriptionState = { status: "closed" };

function useShallowStable<Value>(value: Value): Value {
  const ref = useRef(value);
  if (!shallowEqual(ref.current, value)) ref.current = value;
  return ref.current;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
