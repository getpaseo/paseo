import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { InteractiveFields } from "./fields";
import { artifactMessage } from "./artifact";
import { artifactDocument } from "./runtime/document";

export interface ArtifactCommand {
  session: string;
  command:
    | { type: "disabled"; disabled: boolean }
    | { type: "flush"; id: number }
    | { type: "theme"; colorScheme: "light" | "dark" };
}
interface PendingFlush {
  id: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface ArtifactOptions {
  html: string;
  name: string;
  post: (command: ArtifactCommand) => void;
  colorScheme: "light" | "dark";
}
export function useArtifact({ html, name, post, colorScheme }: ArtifactOptions) {
  const fields = useContext(InteractiveFields);
  const { registerRuntime } = fields;
  const { t } = useTranslation();
  const latest = useRef({ fields, post, colorScheme });
  latest.current = { fields, post, colorScheme };
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [revision, setRevision] = useState(0);
  const [sessionId] = useState(() => crypto.randomUUID());
  const session = `${sessionId}:${revision}`;
  const currentSession = useRef(session);
  currentSession.current = session;
  const [initial] = useState(() => fields.state[name]);
  const source = useRef("");
  const sourceRevision = useRef(-1);
  const ready = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const failed = useRef(false);
  const pending = useRef<PendingFlush | null>(null);
  const nextId = useRef(0);
  if (sourceRevision.current !== revision) {
    sourceRevision.current = revision;
    const value = revision === 0 ? initial : fields.state[name];
    source.current = artifactDocument({
      session,
      html,
      initial: typeof value === "string" ? value : undefined,
      disabled: fields.disabled,
      colorScheme,
    });
  }
  const fail = useCallback(() => {
    failed.current = true;
    setStatus("error");
    if (pending.current) {
      clearTimeout(pending.current.timer);
      pending.current.reject(new Error(t("interactive.renderError")));
      pending.current = null;
    }
  }, [t]);
  const receive = useCallback(
    (raw: unknown) => {
      const parsed = z.object({ session: z.literal(session), message: z.unknown() }).safeParse(raw);
      if (!parsed.success || !alive.current || failed.current || currentSession.current !== session)
        return;
      try {
        const message = artifactMessage(parsed.data.message);
        if (message.type === "ready") {
          ready.current = true;
          setStatus("ready");
          latest.current.post({
            session,
            command: { type: "disabled", disabled: latest.current.fields.disabled },
          });
          latest.current.post({
            session,
            command: { type: "theme", colorScheme: latest.current.colorScheme },
          });
          if (pending.current)
            latest.current.post({ session, command: { type: "flush", id: pending.current.id } });
        } else if (message.type === "error") fail();
        else if (message.type === "state") latest.current.fields.change(name, message.value);
        else if (pending.current?.id === message.id) {
          clearTimeout(pending.current.timer);
          pending.current.resolve();
          pending.current = null;
        }
      } catch {
        fail();
      }
    },
    [session, name, fail],
  );
  useEffect(() => {
    latest.current.post({ session, command: { type: "disabled", disabled: fields.disabled } });
  }, [session, fields.disabled]);
  useEffect(() => {
    latest.current.post({ session, command: { type: "theme", colorScheme } });
  }, [session, colorScheme]);
  useEffect(
    () =>
      registerRuntime(
        () =>
          new Promise<void>((resolve, reject) => {
            if (failed.current || pending.current) {
              reject(new Error(t("interactive.renderError")));
              return;
            }
            const id = ++nextId.current;
            const timer = setTimeout(fail, 10000);
            pending.current = { id, resolve, reject, timer };
            latest.current.post({ session, command: { type: "disabled", disabled: true } });
            if (ready.current) latest.current.post({ session, command: { type: "flush", id } });
          }),
      ),
    [registerRuntime, session, fail, t],
  );
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!ready.current) fail();
    }, 10000);
    return () => {
      clearTimeout(timer);
      if (pending.current) {
        clearTimeout(pending.current.timer);
        pending.current.reject(new Error(t("interactive.renderError")));
        pending.current = null;
      }
    };
  }, [fail, revision, t]);
  const reload = useCallback(() => {
    ready.current = false;
    failed.current = false;
    setStatus("loading");
    setRevision((value) => value + 1);
  }, []);
  return { source: source.current, status, revision, receive, fail, reload };
}
