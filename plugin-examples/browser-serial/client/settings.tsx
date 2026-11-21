import { useCallback, useSyncExternalStore } from "react";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import type { SerialBrowser, SerialSession } from "./session";

const baudRates = [9600, 19200, 38400, 57600, 115200].map((rate) => ({
  label: String(rate),
  value: String(rate),
}));

export function SerialSettings({
  host,
  browser,
  session,
}: PluginSurfaceProps & {
  browser: SerialBrowser;
  session: SerialSession;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const connect = useCallback(() => session.connect(state.baudRate), [session, state.baudRate]);
  const setBaudRate = useCallback((value: string) => session.setBaudRate(Number(value)), [session]);
  const disconnect = useCallback(() => {
    void session.stop();
  }, [session]);
  const release = useCallback(() => {
    void session.release();
  }, [session]);
  const forget = useCallback(() => {
    void session.forget();
  }, [session]);
  return (
    <SettingsSection title="Browser USB serial experiment">
      <SettingsCard>
        <SettingsRow
          label="USB serial byte stream"
          hint="For serial consoles. This does not create a USB device or an OS serial port on the host. Fixed baud rate, 8 data bits, no parity, 1 stop bit; no remote control of baud rate or DTR/RTS."
        />
        <SettingsRow
          label={`Forward to ${host.label}`}
          hint="Only connect a device you want this host to control. Trusted processes on that host can access the temporary TCP port. You can switch to your agent and return here. Keep this browser tab open; closing or reloading it disconnects the device. No automatic reconnect."
        />
        {browser.unavailable ? (
          <SettingsRow label="Browser unavailable" hint={browser.unavailable} />
        ) : null}
        <SettingsSelect
          label="Baud rate"
          value={String(state.baudRate)}
          options={baudRates}
          onValueChange={setBaudRate}
          disabled={state.phase !== "idle"}
        />
        <SettingsAction
          label={state.label}
          actionLabel={state.phase === "connecting" ? "Connecting…" : "Choose and forward device"}
          onPress={connect}
          disabled={Boolean(browser.unavailable) || state.phase !== "idle"}
        />
        {state.endpoint ? (
          <SettingsRow
            label={`Host TCP: ${state.endpoint}`}
            hint={
              state.connected
                ? "Host tool connected. Binary data flows in both directions."
                : "Waiting for an agent tool to connect to this TCP endpoint."
            }
          />
        ) : null}
        {state.phase !== "idle" && state.phase !== "forgetting" ? (
          <SettingsAction
            label="Host tool access"
            hint="Release the current tool so another agent can connect to the same TCP endpoint. The device stays connected. Finish pending device commands before handing over."
            actionLabel={state.releasing ? "Releasing…" : "Release host tool"}
            onPress={release}
            disabled={state.phase !== "active" || !state.connected || state.releasing}
            error={state.releaseError}
          />
        ) : null}
        {state.phase !== "idle" && state.phase !== "forgetting" ? (
          <SettingsAction
            label="End this session"
            actionLabel={state.phase === "stopping" ? "Disconnecting…" : "Disconnect"}
            onPress={disconnect}
            disabled={state.phase === "stopping"}
          />
        ) : null}
        {state.canForget ? (
          <SettingsAction
            label="Browser device permission"
            actionLabel={state.phase === "forgetting" ? "Forgetting…" : "Forget device"}
            onPress={forget}
            disabled={state.phase !== "idle"}
          />
        ) : null}
        {state.error ? <SettingsRow label="Session ended" error={state.error} /> : null}
      </SettingsCard>
    </SettingsSection>
  );
}
