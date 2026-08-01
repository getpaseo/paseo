/**
 * Live Voice runtime — the non-React state machine behind the feature.
 *
 * Same shape as `@/voice/voice-runtime`: a plain object with a listener set and
 * a stable snapshot, so React can consume it through `useSyncExternalStore`
 * without the runtime knowing React exists.
 *
 * It owns exactly four things, and nothing else in the app owns any of them:
 *   - the WebRTC session handle,
 *   - the `voice.live.update` subscription (and the stale-update filter),
 *   - the finalized transcript list,
 *   - the microphone lease token.
 *
 * Errors are reported structurally (`code` + optional server message) rather
 * than as prose, so the UI owns all translation.
 */

import type { SessionOutboundMessage, VoiceLiveEvent } from "@getpaseo/protocol/messages";
import {
  audioSessionLease,
  type AudioSessionLease,
  type AudioSessionLeaseToken,
  type AudioSessionOwner,
} from "@/audio/audio-session-lease";
import {
  isLiveVoiceSessionSupported,
  startLiveVoiceSession,
  type LiveVoiceSession,
  type LiveVoiceSessionMode,
  type StartLiveVoiceSessionOptions,
} from "@/live-voice/live-voice-session";

type VoiceLiveUpdateMessage = Extract<SessionOutboundMessage, { type: "voice.live.update" }>;

export type LiveVoicePhase = "idle" | "starting" | "active" | "stopping" | "error";

export interface LiveVoiceTranscriptEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
}

/**
 * `code` is an open string: the daemon's rejection codes stay `z.string()` on the
 * wire so a newer daemon can add codes without breaking us. The UI translates the
 * codes it knows and falls back to `message`.
 */
export interface LiveVoiceErrorInfo {
  code: string;
  message: string | null;
  /** Set when `code` is `mic_busy`: who is holding the microphone lease. */
  owner?: AudioSessionOwner;
}

export interface LiveVoiceSnapshot {
  phase: LiveVoicePhase;
  serverId: string | null;
  liveSessionId: string | null;
  sessionMode: LiveVoiceSessionMode | null;
  isMuted: boolean;
  /** Autoplay policy blocked remote audio; the UI must offer "tap to enable audio". */
  isAudioBlocked: boolean;
  transcripts: LiveVoiceTranscriptEntry[];
  error: LiveVoiceErrorInfo | null;
  /** `cause` of the last terminal `closed` update, for a post-call explanation. */
  closedCause: string | null;
}

/**
 * The slice of `DaemonClient` the runtime needs. Narrowed to three calls so tests
 * can supply a plain object instead of a real client.
 *
 * `subscribeUpdates` exists rather than the client's `on(type, handler)` because
 * `on` is an overloaded generic; a one-line adapter at the construction site
 * (`client.on("voice.live.update", handler)`) keeps the runtime's dependency
 * surface honest and mockable.
 */
export interface LiveVoiceDaemonClient {
  startLiveVoice(input: {
    offerSdp: string;
    ambientAgentReports?: boolean;
    ambientAgentGuidance?: string;
  }): Promise<{ liveSessionId: string; answerSdp: string }>;
  stopLiveVoice(input: { liveSessionId: string }): Promise<void>;
  subscribeUpdates(handler: (message: VoiceLiveUpdateMessage) => void): () => void;
}

export interface LiveVoiceConnectionPin {
  readonly client: LiveVoiceDaemonClient;
  release(): void;
}

export interface LiveVoiceRuntimeDeps {
  getClient(serverId: string): LiveVoiceDaemonClient | null;
  /**
   * Pin the exact daemon client used for the call so HostRuntime cannot replace
   * its transport after SDP negotiation. Optional for non-mobile/test hosts.
   */
  pinConnection?(serverId: string): LiveVoiceConnectionPin | null;
  startSession(options: StartLiveVoiceSessionOptions): Promise<LiveVoiceSession>;
  isSessionSupported: boolean;
  lease: AudioSessionLease;
  /**
   * Reporting agents this call did not start. Absent on hosts that have no
   * multi-host registry to watch (tests, and any client without one).
   */
  ambientAgentReports?: {
    /** The user's setting, read at start so a mid-call change cannot confuse the model. */
    read(): { enabled: boolean; guidance: string | undefined };
    enable(input: { sourceServerId: string; liveSessionId: string }): Promise<void>;
    disable(input: { liveSessionId: string }): Promise<void>;
  };
}

export interface LiveVoiceRuntime {
  subscribe(listener: () => void): () => void;
  getSnapshot(): LiveVoiceSnapshot;
  start(serverId: string, sessionMode?: LiveVoiceSessionMode): Promise<void>;
  stop(): Promise<void>;
  toggleMute(): void;
  /** Retry autoplay-blocked playback. Must be driven by a user gesture. */
  resumeAudio(): Promise<void>;
  /**
   * Clear a terminal error/ended state and its retained transcript from the
   * footer control. No-op while a call is live.
   */
  dismiss(): void;
  isActiveForServer(serverId: string): boolean;
  /**
   * The host replaced the exact pinned client this call was placed over. Tears
   * the local half down because the replacement cannot address the retained
   * daemon session. A transient socket disconnect on the same client is handled
   * by that client's reconnect loop and must not call this method.
   */
  handleConnectionLost(serverId: string): void;
  destroy(): Promise<void>;
}

/** Thrown by `start`. Mirrors the snapshot's `error` so callers can toast it. */
export class LiveVoiceStartError extends Error {
  readonly name = "LiveVoiceStartError";
  readonly info: LiveVoiceErrorInfo;

  constructor(info: LiveVoiceErrorInfo) {
    super(info.message ?? info.code);
    this.info = info;
  }
}

/**
 * Upper bound on retained transcript entries. A call is open-ended, so without a
 * cap a long conversation grows the snapshot (and every re-render that copies
 * it) forever. The UI only ever shows the tail; older entries just age out.
 */
const MAX_RETAINED_TRANSCRIPTS = 200;

/**
 * Guidance only travels when reports are on: it exists to shape reports, and
 * sending it without them would describe a behavior the call does not have.
 */
function toAmbientStartFields(
  ambient: { enabled: boolean; guidance: string | undefined } | undefined,
): {
  ambientAgentReports?: true;
  ambientAgentGuidance?: string;
} {
  if (!ambient?.enabled) {
    return {};
  }
  return {
    ambientAgentReports: true,
    ...(ambient.guidance ? { ambientAgentGuidance: ambient.guidance } : {}),
  };
}

/**
 * Arms the ambient watches once the call is live. Deliberately not awaited: a
 * host that is slow to arm must not delay the conversation the user is already
 * having, and a host that never arms just does not report.
 */
function beginAmbientAgentReports(
  deps: LiveVoiceRuntimeDeps,
  startFields: { ambientAgentReports?: true },
  sourceServerId: string,
  liveSessionId: string,
): void {
  if (!startFields.ambientAgentReports) {
    return;
  }
  void deps.ambientAgentReports?.enable({ sourceServerId, liveSessionId }).catch(() => undefined);
}

const IDLE_SNAPSHOT: LiveVoiceSnapshot = {
  phase: "idle",
  serverId: null,
  liveSessionId: null,
  sessionMode: null,
  isMuted: false,
  isAudioBlocked: false,
  transcripts: [],
  error: null,
  closedCause: null,
};

export function createDefaultLiveVoiceRuntimeDeps(
  getClient: (serverId: string) => LiveVoiceDaemonClient | null,
  pinConnection?: (serverId: string) => LiveVoiceConnectionPin | null,
  ambientAgentReports?: LiveVoiceRuntimeDeps["ambientAgentReports"],
): LiveVoiceRuntimeDeps {
  return {
    getClient,
    ...(pinConnection ? { pinConnection } : {}),
    ...(ambientAgentReports ? { ambientAgentReports } : {}),
    startSession: startLiveVoiceSession,
    isSessionSupported: isLiveVoiceSessionSupported,
    lease: audioSessionLease,
  };
}

export function createLiveVoiceRuntime(deps: LiveVoiceRuntimeDeps): LiveVoiceRuntime {
  const listeners = new Set<() => void>();
  let snapshot: LiveVoiceSnapshot = IDLE_SNAPSHOT;

  // Live call resources. All cleared together by `cleanupLocal`.
  let session: LiveVoiceSession | null = null;
  let unsubscribeUpdates: (() => void) | null = null;
  let leaseToken: AudioSessionLeaseToken | null = null;
  let connectionPin: LiveVoiceConnectionPin | null = null;
  let daemonClient: LiveVoiceDaemonClient | null = null;
  // Updates that arrived before the start response told us our liveSessionId.
  // The daemon may push `started` (or even `closed`) before it answers, so they
  // are buffered and replayed once the id is known.
  let pendingUpdates: VoiceLiveUpdateMessage[] = [];
  // Invalidates in-flight async work from a superseded start/stop.
  let generation = 0;
  // While `deps.startSession` is in flight the microphone is physically open even
  // though `session` is still null, so a superseding stop() must not release the
  // lease — the start's settlement path does, after closing the real session.
  let startInFlight = false;

  function publish(next: LiveVoiceSnapshot): void {
    if (next === snapshot) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A broken subscriber must not wedge the call.
      }
    }
  }

  function patch(update: Partial<LiveVoiceSnapshot>): void {
    publish({ ...snapshot, ...update });
  }

  /**
   * Idempotent teardown of everything the runtime owns locally. Deliberately does
   * not touch the daemon: callers decide whether a stop RPC is warranted.
   */
  function cleanupLocal(): void {
    // Every way a call can end converges here, so this is the one place the
    // ambient watches have to be dropped — client stop, provider error, lost
    // connection, and runtime teardown alike. Reads the id before the snapshot
    // is cleared; callers publish the idle snapshot after this returns.
    if (snapshot.liveSessionId) {
      const endedLiveSessionId = snapshot.liveSessionId;
      void deps.ambientAgentReports
        ?.disable({ liveSessionId: endedLiveSessionId })
        .catch(() => undefined);
    }
    pendingUpdates = [];
    if (unsubscribeUpdates) {
      const unsubscribe = unsubscribeUpdates;
      unsubscribeUpdates = null;
      unsubscribe();
    }
    if (session) {
      const active = session;
      session = null;
      active.close();
    }
    if (!startInFlight) {
      if (leaseToken) {
        const token = leaseToken;
        leaseToken = null;
        deps.lease.release(token);
      }
      if (connectionPin) {
        const pin = connectionPin;
        connectionPin = null;
        pin.release();
      }
      daemonClient = null;
    }
  }

  function applyEvent(event: VoiceLiveEvent): void {
    switch (event.kind) {
      case "started":
        // The handshake already put us in `active`; nothing to reconcile.
        return;
      case "transcript": {
        const entry: LiveVoiceTranscriptEntry = {
          id: event.transcriptId,
          role: event.role,
          text: event.text,
        };
        const existing = snapshot.transcripts.findIndex((item) => item.id === entry.id);
        const transcripts =
          existing === -1
            ? [...snapshot.transcripts, entry].slice(-MAX_RETAINED_TRANSCRIPTS)
            : snapshot.transcripts.map((item, index) => (index === existing ? entry : item));
        patch({ transcripts });
        return;
      }
      case "error": {
        const info: LiveVoiceErrorInfo = { code: event.code, message: event.message };
        if (!event.fatal) {
          // Non-fatal: surface it but keep the call up.
          patch({ error: info });
          return;
        }
        cleanupLocal();
        publish({ ...snapshot, phase: "error", error: info, liveSessionId: null });
        return;
      }
      case "closed": {
        cleanupLocal();
        // A fatal error already explains the closure; don't overwrite it with a
        // bare cause. Otherwise a close is just the end of the call.
        const keepError = snapshot.phase === "error" && snapshot.error !== null;
        publish({
          ...snapshot,
          phase: keepError ? "error" : "idle",
          liveSessionId: null,
          isAudioBlocked: false,
          closedCause: event.cause,
        });
        return;
      }
    }
  }

  function handleUpdate(message: VoiceLiveUpdateMessage): void {
    if (snapshot.liveSessionId === null) {
      // Still handshaking: we can't tell ours from a stale call's yet.
      pendingUpdates.push(message);
      return;
    }
    if (message.payload.liveSessionId !== snapshot.liveSessionId) {
      return;
    }
    applyEvent(message.payload.event);
  }

  function flushPendingUpdates(liveSessionId: string): void {
    const buffered = pendingUpdates;
    pendingUpdates = [];
    for (const message of buffered) {
      if (message.payload.liveSessionId !== liveSessionId) {
        continue;
      }
      if (snapshot.liveSessionId !== liveSessionId) {
        // A buffered terminal event already tore the call down.
        return;
      }
      applyEvent(message.payload.event);
    }
  }

  function failStart(
    serverId: string,
    sessionMode: LiveVoiceSessionMode,
    info: LiveVoiceErrorInfo,
  ): never {
    cleanupLocal();
    publish({ ...IDLE_SNAPSHOT, phase: "error", serverId, sessionMode, error: info });
    throw new LiveVoiceStartError(info);
  }

  function toErrorInfo(error: unknown): LiveVoiceErrorInfo {
    if (error && typeof error === "object") {
      const candidate = error as { errorCode?: unknown; code?: unknown; message?: unknown };
      const code = typeof candidate.errorCode === "string" ? candidate.errorCode : candidate.code;
      if (typeof code === "string" && code.length > 0) {
        return {
          code,
          message: typeof candidate.message === "string" ? candidate.message : null,
        };
      }
    }
    return {
      code: "start_failed",
      message: error instanceof Error ? error.message : null,
    };
  }

  const runtime: LiveVoiceRuntime = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot() {
      return snapshot;
    },

    async start(serverId, sessionMode = "background") {
      if (snapshot.phase === "starting" || snapshot.phase === "active") {
        throw new LiveVoiceStartError({ code: "already_active", message: null });
      }
      if (snapshot.phase === "stopping") {
        throw new LiveVoiceStartError({ code: "stopping", message: null });
      }
      if (!deps.isSessionSupported) {
        failStart(serverId, sessionMode, { code: "unsupported", message: null });
      }
      const pin = deps.pinConnection?.(serverId) ?? null;
      // When pinning is available, never silently fall back to an unpinned
      // client: a probe-driven transport swap would orphan the daemon-owned
      // call immediately after negotiation.
      const client = deps.pinConnection ? (pin?.client ?? null) : deps.getClient(serverId);
      if (!client) {
        failStart(serverId, sessionMode, { code: "not_connected", message: null });
      }
      connectionPin = pin;
      daemonClient = client;

      // Take the mic before any state churn so a refusal leaves us untouched.
      const token = deps.lease.acquire("liveVoice");
      if (!token) {
        const owner = deps.lease.current();
        failStart(serverId, sessionMode, {
          code: "mic_busy",
          message: null,
          ...(owner ? { owner } : {}),
        });
      }
      leaseToken = token;

      const startGeneration = ++generation;
      pendingUpdates = [];
      publish({ ...IDLE_SNAPSHOT, phase: "starting", serverId, sessionMode });

      // Subscribe before negotiating: the daemon can push `started` (or a
      // terminal event) before it answers the start request.
      unsubscribeUpdates = client.subscribeUpdates((message) => {
        if (generation !== startGeneration) {
          return;
        }
        handleUpdate(message);
      });

      // Read once, before negotiating: the prompt the model gets is fixed at
      // start, so a switch flipped mid-call must not leave the two disagreeing.
      const ambientStartFields = toAmbientStartFields(deps.ambientAgentReports?.read());

      const sessionOptions: StartLiveVoiceSessionOptions = {
        mode: sessionMode,
        negotiate: (offerSdp) => client.startLiveVoice({ offerSdp, ...ambientStartFields }),
        onAudioBlocked: () => {
          if (generation !== startGeneration) return;
          patch({ isAudioBlocked: true });
        },
        onAudioResumed: () => {
          if (generation !== startGeneration) return;
          patch({ isAudioBlocked: false });
        },
        onTerminal: (info) => {
          if (generation !== startGeneration) return;
          const liveSessionId = snapshot.liveSessionId;
          cleanupLocal();
          publish({
            ...snapshot,
            phase: "error",
            liveSessionId: null,
            isAudioBlocked: false,
            error: { code: info.code, message: info.message },
          });
          // Best effort: tell the daemon the local half is gone.
          if (liveSessionId) {
            void client.stopLiveVoice({ liveSessionId }).catch(() => undefined);
          }
        },
      };

      // Frees the lease for a start that was superseded mid-negotiation: the
      // superseding stop()'s cleanup deliberately left it held (the mic was
      // still physically open) and it is only safe to release here, once the
      // in-flight session is actually closed.
      const releaseSupersededResources = () => {
        if (leaseToken === token) {
          leaseToken = null;
        }
        deps.lease.release(token);
        if (connectionPin === pin) {
          connectionPin = null;
        }
        pin?.release();
        if (daemonClient === client) {
          daemonClient = null;
        }
      };

      let started: LiveVoiceSession;
      startInFlight = true;
      try {
        started = await deps.startSession(sessionOptions);
      } catch (error) {
        startInFlight = false;
        if (generation !== startGeneration) {
          releaseSupersededResources();
          throw error instanceof Error ? error : new Error(String(error));
        }
        failStart(serverId, sessionMode, toErrorInfo(error));
      } finally {
        startInFlight = false;
      }

      if (generation !== startGeneration) {
        // A stop() or a newer start() superseded us while negotiating.
        started.close();
        releaseSupersededResources();
        void client.stopLiveVoice({ liveSessionId: started.liveSessionId }).catch(() => undefined);
        return;
      }

      session = started;
      publish({
        ...snapshot,
        phase: "active",
        liveSessionId: started.liveSessionId,
        isMuted: false,
      });
      flushPendingUpdates(started.liveSessionId);

      beginAmbientAgentReports(deps, ambientStartFields, serverId, started.liveSessionId);
    },

    async stop() {
      const { serverId, liveSessionId, phase } = snapshot;
      const client = daemonClient;
      generation += 1;
      if (phase === "idle") {
        cleanupLocal();
        return;
      }
      patch({ phase: "stopping" });
      cleanupLocal();
      publish({ ...IDLE_SNAPSHOT, serverId, transcripts: snapshot.transcripts });

      if (!serverId || !liveSessionId) {
        return;
      }
      // Best effort: the daemon's stop is idempotent and it has its own terminal
      // causes, so a failure here must not leave the UI stuck in `stopping`.
      await client?.stopLiveVoice({ liveSessionId }).catch(() => undefined);
    },

    toggleMute() {
      if (!session || snapshot.phase !== "active") {
        return;
      }
      const nextMuted = !snapshot.isMuted;
      session.setMuted(nextMuted);
      patch({ isMuted: nextMuted });
    },

    async resumeAudio() {
      await session?.resumeAudio();
    },

    dismiss() {
      if (snapshot.phase !== "idle" && snapshot.phase !== "error") {
        return;
      }
      publish(IDLE_SNAPSHOT);
    },

    isActiveForServer(serverId) {
      return (
        (snapshot.phase === "active" || snapshot.phase === "starting") &&
        snapshot.serverId === serverId
      );
    },

    handleConnectionLost(serverId) {
      if (snapshot.phase === "idle" || snapshot.serverId !== serverId) {
        return;
      }
      // Invalidate any in-flight start so its continuation can't revive the call.
      generation += 1;
      const { transcripts } = snapshot;
      cleanupLocal();
      publish({
        ...IDLE_SNAPSHOT,
        serverId,
        sessionMode: snapshot.sessionMode,
        transcripts,
        // The old client session eventually reports the same cause when it expires.
        closedCause: "owner_disconnected",
      });
    },

    async destroy() {
      await runtime.stop().catch(() => undefined);
      listeners.clear();
    },
  };

  return runtime;
}
