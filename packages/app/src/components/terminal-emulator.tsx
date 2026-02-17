"use dom";

import { useEffect, useRef } from "react";
import type { DOMProps } from "expo/dom";
import "@xterm/xterm/css/xterm.css";
import type { PendingTerminalModifiers } from "../utils/terminal-keys";
import { TerminalEmulatorRuntime } from "../terminal/runtime/terminal-emulator-runtime";

interface TerminalEmulatorProps {
  dom?: DOMProps;
  streamKey: string;
  initialOutputText: string;
  outputChunkText: string;
  outputChunkSequence: number;
  testId?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  cursorColor?: string;
  onInput?: (data: string) => Promise<void> | void;
  onResize?: (input: { rows: number; cols: number }) => Promise<void> | void;
  onTerminalKey?: (input: {
    key: string;
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
    meta: boolean;
  }) => Promise<void> | void;
  onPendingModifiersConsumed?: () => Promise<void> | void;
  onOutputChunkConsumed?: (sequence: number) => Promise<void> | void;
  pendingModifiers?: PendingTerminalModifiers;
  focusRequestToken?: number;
  resizeRequestToken?: number;
}

declare global {
  interface Window {}
}

export default function TerminalEmulator({
  streamKey,
  initialOutputText,
  outputChunkText,
  outputChunkSequence,
  testId = "terminal-surface",
  backgroundColor = "#0b0b0b",
  foregroundColor = "#e6e6e6",
  cursorColor = "#e6e6e6",
  onInput,
  onResize,
  onTerminalKey,
  onPendingModifiersConsumed,
  onOutputChunkConsumed,
  pendingModifiers = { ctrl: false, shift: false, alt: false },
  focusRequestToken = 0,
  resizeRequestToken = 0,
}: TerminalEmulatorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<TerminalEmulatorRuntime | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const root = rootRef.current;
    if (!host || !root) {
      return;
    }

    const runtime = new TerminalEmulatorRuntime();
    runtimeRef.current = runtime;
    runtime.setCallbacks({
      callbacks: {
        onInput,
        onResize,
        onTerminalKey,
        onPendingModifiersConsumed,
      },
    });
    runtime.setPendingModifiers({ pendingModifiers });
    runtime.mount({
      root,
      host,
      initialOutputText,
      theme: {
        backgroundColor,
        foregroundColor,
        cursorColor,
      },
    });

    return () => {
      runtime.unmount();
      if (runtimeRef.current === runtime) {
        runtimeRef.current = null;
      }
    };
  }, [backgroundColor, cursorColor, foregroundColor, streamKey]);

  useEffect(() => {
    runtimeRef.current?.setCallbacks({
      callbacks: {
        onInput,
        onResize,
        onTerminalKey,
        onPendingModifiersConsumed,
      },
    });
  }, [onInput, onPendingModifiersConsumed, onResize, onTerminalKey]);

  useEffect(() => {
    runtimeRef.current?.setPendingModifiers({ pendingModifiers });
  }, [pendingModifiers]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (outputChunkSequence <= 0) {
      return;
    }

    if (!runtime) {
      onOutputChunkConsumed?.(outputChunkSequence);
      return;
    }

    if (outputChunkText.length === 0) {
      runtime.clear({
        onCommitted: () => {
          onOutputChunkConsumed?.(outputChunkSequence);
        },
      });
      return;
    }
    runtime.write({
      text: outputChunkText,
      onCommitted: () => {
        onOutputChunkConsumed?.(outputChunkSequence);
      },
    });
  }, [onOutputChunkConsumed, outputChunkSequence, outputChunkText]);

  useEffect(() => {
    if (focusRequestToken <= 0) {
      return;
    }
    runtimeRef.current?.focus();
  }, [focusRequestToken]);

  useEffect(() => {
    if (resizeRequestToken <= 0) {
      return;
    }
    runtimeRef.current?.resize({ force: true });
  }, [resizeRequestToken]);

  return (
    <div
      ref={rootRef}
      data-testid={testId}
      style={{
        position: "relative",
        display: "flex",
        width: "100%",
        height: "100%",
        minHeight: 0,
        minWidth: 0,
        backgroundColor,
        overflow: "hidden",
        overscrollBehavior: "none",
      }}
      onPointerDown={() => {
        runtimeRef.current?.focus();
      }}
    >
      <div
        ref={hostRef}
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          width: "100%",
          height: "100%",
          overflow: "hidden",
          overscrollBehavior: "none",
        }}
      />
    </div>
  );
}
