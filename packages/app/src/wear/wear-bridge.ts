import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

import type { LiveVoiceAvailability } from "@/live-voice/live-voice-availability-policy";
import type { LiveVoiceSnapshot } from "@/live-voice/live-voice-runtime";
import {
  parseWearCommand,
  type WearCommand,
  type WearLiveVoiceState,
  type WearSnapshot,
} from "./wear-protocol";
import { buildWearLiveVoiceState, stableLiveVoiceKey } from "./wear-live-voice";
import { buildWearSnapshot, type WearSnapshotInput } from "./wear-snapshot";
import { buildWearTranscript, isTranscriptEntry, MAX_TRANSCRIPT_ENTRIES } from "./wear-transcript";

export interface WearBridgeTransport {
  publishSnapshot(payload: string): Promise<boolean>;
  /** Publishes to a per-agent path, so open transcripts don't clobber each other. */
  publishTranscript(agentId: string, payload: string): Promise<boolean>;
  /** Publishes one project's icon bytes, keyed by the snapshot's projectKey. */
  publishProjectIcon(projectKey: string, dataBase64: string, mimeType: string): Promise<boolean>;
  /** Publishes the single Live Voice state item. Absent on older phone builds. */
  publishLiveVoice(payload: string): Promise<boolean>;
  addCommandListener(listener: (payload: string) => void): { remove(): void };
  drainPendingCommands(): Promise<string[]>;
}

/**
 * The slice of the app's Live Voice runtime the bridge drives, plus the host
 * availability the watch needs to offer a choice.
 *
 * Narrowed to five calls so tests can pass a plain object, and so the bridge
 * stays ignorant of React — the runtime is already a plain subscribe/snapshot
 * store, which is what makes this possible.
 */
export interface WearLiveVoiceController {
  subscribe(listener: () => void): () => void;
  getSnapshot(): LiveVoiceSnapshot;
  readAvailability(): LiveVoiceAvailability;
  /**
   * Place a call on this host. The adapter picks background mode — a call driven
   * from the wrist is by definition one where nobody is looking at the phone.
   */
  start(serverId: string): Promise<void>;
  stop(): Promise<void>;
  toggleMute(): void;
}

/**
 * Paging for a transcript request.
 *
 * The daemon's tail page is sized for a phone screen, so reaching a wrist-sized
 * transcript usually takes more than one. The request cap is a hard stop: a watch
 * asking for an agent with a very long history must not turn into an unbounded
 * walk backwards through its timeline.
 */
const TRANSCRIPT_PAGE_SIZE = 40;
const MAX_TRANSCRIPT_REQUESTS = 4;

/**
 * How long a transcript request keeps the phone pushing updates for that agent.
 *
 * The watch re-requests roughly once a minute while an agent screen is open, so this
 * is set well above that cadence: an open screen renews long before the lease lapses,
 * and a screen the user left stops costing timeline fetches within ~2.5 minutes.
 */
const LEASE_MS = 150_000;

/**
 * Trailing delay before a leased agent's transcript is refetched.
 *
 * A single agent turn produces a burst of store changes, and each transcript refresh
 * is several daemon round-trips plus a Data Layer write. Coalescing turns the burst
 * into one fetch while still landing on the wrist within a couple of seconds.
 */
const COALESCE_MS = 2_000;

/**
 * Trailing delay before a transcript-only Live Voice change is published.
 *
 * A call emits transcript deltas continuously — several a second while either
 * side is talking — and each publish is a Data Layer write over Bluetooth.
 * Anything that changes what the *controls* do (phase, mute, host list, error)
 * skips this and publishes immediately; only the words wait.
 */
const LIVE_VOICE_COALESCE_MS = 700;

/** A watch is currently reading this agent's transcript. */
interface TranscriptLease {
  serverId: string;
  agentId: string;
  expiresAt: number;
  /**
   * `lastActivityAt` as of the most recent fetch we started, which is what a later
   * sweep compares against. Recorded before the fetch rather than after, so activity
   * that happens while the fetch is in flight still triggers a follow-up. Null means
   * the agent wasn't in state at that moment, which counts as "unknown", not "quiet".
   */
  lastActivityAt: number | null;
}

export interface NewAgentConfig {
  provider: string;
  cwd: string;
}

export interface WearBridgeDeps {
  transport: WearBridgeTransport;
  /** Current state of every connected daemon, one entry per server. */
  readState: () => WearSnapshotInput[];
  /** Daemon client for a server, or null when that server isn't connected. */
  getClient: (serverId: string) => DaemonClient | null;
  /**
   * Provider and cwd for a new agent in a workspace. The watch has no provider
   * picker by design, so the phone decides — normally by reusing whatever provider
   * that workspace last used. Returning null refuses the create.
   */
  resolveNewAgentConfig: (serverId: string, workspaceId: string) => NewAgentConfig | null;
  /**
   * Live Voice control. Absent on hosts that have no runtime (tests, and any
   * build without the feature), in which case the bridge never publishes the
   * state item and the watch shows its "not available" screen.
   */
  liveVoice?: WearLiveVoiceController;
  now?: () => number;
  logger?: {
    warn(message: string, error?: unknown): void;
    info?(message: string): void;
  };
}

/**
 * Owns the phone half of the watch bridge: publishes snapshots and executes the
 * commands the watch sends back.
 *
 * Transport is injected so this is testable without Play Services — the native
 * module is one implementation of [WearBridgeTransport], not a hard dependency.
 */
export class WearBridge {
  private readonly deps: WearBridgeDeps;
  private subscription: { remove(): void } | null = null;
  private lastPublished: string | null = null;
  /** Tail of the publish chain; see [publish] for why runs are serialized. */
  private publishQueue: Promise<void> = Promise.resolve();
  // All three are keyed by serverScopedKey(), not by agent id: ids are only unique within a
  // server, so two daemons running the same id would otherwise share a lease, cancel
  // each other's timers, and have one fetch discarded by the other's generation.
  /** Per-agent request counter, so a slow fetch can't overwrite a newer transcript. */
  private readonly transcriptGenerations = new Map<string, number>();
  /** Agents a watch is currently reading. */
  private readonly transcriptLeases = new Map<string, TranscriptLease>();
  /** At most one pending refresh per agent; the handle is what makes it coalesce. */
  private readonly transcriptTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * In-flight or settled icon lookups, keyed by server+directory.
   *
   * A project's icon is a file on disk that we scan for once and then treat as fixed
   * for the life of the bridge — the same lifetime the phone UI's query cache gives
   * it. A resolved null is cached too: "this repo has no icon" is the common answer
   * and re-asking on every publish would be a daemon round-trip per project per
   * store change. Only a *failed* lookup is evicted, so a disconnect can retry.
   */
  private readonly iconLookups = new Map<string, Promise<WearProjectIcon | null>>();
  /** Icon bytes currently on the wrist, per projectKey, so we don't republish them. */
  private readonly publishedIcons = new Map<string, string>();
  /** Icon syncs are serial: two overlapping runs would race on publishedIcons. */
  private iconSyncRunning = false;
  /** Last Live Voice state that landed, so an unchanged one isn't rewritten. */
  private lastPublishedLiveVoice: WearLiveVoiceState | null = null;
  /** Set while a transcript-only change is waiting out LIVE_VOICE_COALESCE_MS. */
  private liveVoiceTimer: ReturnType<typeof setTimeout> | null = null;
  private liveVoiceSubscription: (() => void) | null = null;
  private disposed = false;

  constructor(deps: WearBridgeDeps) {
    this.deps = deps;
  }

  async start(): Promise<void> {
    if (this.subscription) return;
    this.subscription = this.deps.transport.addCommandListener((payload) => {
      void this.handleCommandPayload(payload);
    });

    // A call can already be running when the bridge starts — the runtime survives
    // any remount of the listener — so subscribe before the first publish rather
    // than waiting for the next change to reveal it.
    this.liveVoiceSubscription =
      this.deps.liveVoice?.subscribe(() => {
        void this.syncLiveVoice();
      }) ?? null;

    // Commands can arrive while the app process is dead — Play Services starts only
    // the native listener service, which persists them. Drain before the first
    // publish so a queued approval isn't overwritten by a snapshot that still shows
    // it pending. publish() also carries the first Live Voice state out.
    await this.drainQueued();
    await this.publish();
  }

  stop(): void {
    this.disposed = true;
    this.subscription?.remove();
    this.subscription = null;
    this.liveVoiceSubscription?.();
    this.liveVoiceSubscription = null;
    if (this.liveVoiceTimer !== null) {
      clearTimeout(this.liveVoiceTimer);
      this.liveVoiceTimer = null;
    }
    for (const timer of this.transcriptTimers.values()) {
      clearTimeout(timer);
    }
    this.transcriptTimers.clear();
    this.transcriptLeases.clear();
  }

  /**
   * Decide whether a Live Voice change goes out now or waits.
   *
   * The split is by what the change means to someone looking at their wrist: a
   * phase, mute, host, availability or error change moves a control and must
   * land immediately; a new phrase can wait out the coalescing window with the
   * phrases behind it.
   */
  private async syncLiveVoice(): Promise<void> {
    if (this.disposed || !this.deps.liveVoice) return;

    const next = this.buildLiveVoiceState();
    if (next === null) return;
    const previous = this.lastPublishedLiveVoice;
    if (previous !== null && stableLiveVoiceKey(next) === stableLiveVoiceKey(previous)) return;

    if (previous === null || isLiveVoiceControlChange(previous, next)) {
      if (this.liveVoiceTimer !== null) {
        clearTimeout(this.liveVoiceTimer);
        this.liveVoiceTimer = null;
      }
      await this.publishLiveVoice();
      return;
    }

    if (this.liveVoiceTimer !== null) return;
    this.liveVoiceTimer = setTimeout(() => {
      this.liveVoiceTimer = null;
      void this.publishLiveVoice();
    }, LIVE_VOICE_COALESCE_MS);
  }

  private buildLiveVoiceState(): WearLiveVoiceState | null {
    const liveVoice = this.deps.liveVoice;
    if (!liveVoice) return null;
    return buildWearLiveVoiceState(
      { snapshot: liveVoice.getSnapshot(), availability: liveVoice.readAvailability() },
      this.deps.now?.() ?? Date.now(),
    );
  }

  /**
   * Publish the Live Voice state item.
   *
   * Skipped entirely when there is no runtime: an absent item is what the watch
   * reads as "this phone build has no Live Voice", which is the honest answer and
   * needs no separate flag on the wire.
   */
  private async publishLiveVoice(): Promise<void> {
    if (this.disposed) return;
    const state = this.buildLiveVoiceState();
    if (state === null) return;

    const previous = this.lastPublishedLiveVoice;
    if (previous !== null && stableLiveVoiceKey(state) === stableLiveVoiceKey(previous)) return;

    const ok = await this.deps.transport
      .publishLiveVoice(JSON.stringify(state))
      .catch((error: unknown) => {
        this.deps.logger?.warn("Failed to publish wear live voice state", error);
        return false;
      });
    if (ok) {
      this.lastPublishedLiveVoice = state;
    }
  }

  private async drainQueued(): Promise<void> {
    const queued = await this.deps.transport.drainPendingCommands().catch((error: unknown) => {
      this.deps.logger?.warn("Failed to drain queued wear commands", error);
      return [] as string[];
    });
    for (const payload of queued) {
      await this.handleCommandPayload(payload);
    }
  }

  /**
   * Publish the current state. Skips the native call when the JSON is byte-identical
   * to the last publish, because building the payload is cheap but waking the Data
   * Layer is not.
   *
   * Runs are serialized through [publishQueue]: a session-store write and the
   * host-runtime emit for the same underlying event both land here in the same
   * tick, and only serialization lets the second run see what the first one
   * published — otherwise both pass the unchanged-payload check and the Data
   * Layer is woken twice for identical state.
   */
  publish(options?: { force?: boolean }): Promise<void> {
    const run = this.publishQueue.then(() => this.publishNow(options));
    this.publishQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async publishNow(options?: { force?: boolean }): Promise<void> {
    // Re-checked here rather than in publish(): a queued run can be dequeued
    // after stop(), and publishing then would write the dead bridge's state over
    // whatever a replacement bridge has already put on the wrist.
    if (this.disposed) return;
    const now = this.deps.now?.() ?? Date.now();
    const state = this.deps.readState();

    // Ahead of the unchanged-payload short-circuit below, because most new activity
    // does not change the snapshot at all: the only agent field it moves is `age`,
    // which is minute-granular. Sweeping after the early return would leave open
    // transcripts stale for up to a minute, which is the bug this exists to fix.
    this.sweepTranscriptLeases(state, now);

    const snapshot = buildWearSnapshot(state, now);
    const payload = stableSnapshotKey(snapshot);

    if (options?.force || payload !== this.lastPublished) {
      const ok = await this.deps.transport
        .publishSnapshot(JSON.stringify(snapshot))
        .catch((error: unknown) => {
          this.deps.logger?.warn("Failed to publish wear snapshot", error);
          return false;
        });
      if (ok) {
        this.lastPublished = payload;
        // Only after a payload that actually landed: the set of projects can only have
        // changed if the snapshot did. Deliberately not awaited — an icon is decoration,
        // and a slow daemon must never hold up the next snapshot.
        void this.syncProjectIcons();
      }
    }

    // Availability is read from the host and session stores at build time, and
    // those stores never tick the Live Voice runtime's own subscription — a host
    // coming online only surfaces through a publish. After the snapshot write so
    // a wrist tap's ack is never queued behind a Live Voice Data Layer item, and
    // past the short-circuit above, which knows nothing about Live Voice.
    await this.syncLiveVoice();
  }

  /**
   * Publish an icon for every project currently on the watch.
   *
   * Ordered fetch-then-publish per project rather than a fan-out: this runs off a
   * store change, and a burst of parallel daemon requests plus Data Layer writes is
   * exactly what we don't want competing with the transcript path. Every failure is
   * a warning and a skip — the watch draws a colored initial for any project whose
   * icon never arrives, which is a perfectly good outcome.
   */
  private async syncProjectIcons(): Promise<void> {
    // A publish that arrives mid-run is dropped rather than queued: state is read at
    // the top of the run, and the next changed snapshot will sweep anything new.
    if (this.iconSyncRunning || this.disposed) return;
    this.iconSyncRunning = true;
    try {
      for (const target of collectIconTargets(this.deps.readState())) {
        if (this.disposed) return;

        const icon = await this.lookupProjectIcon(target.serverId, target.iconDir);
        if (!icon) continue;
        if (this.publishedIcons.get(target.projectKey) === icon.data) continue;

        const ok = await this.deps.transport
          .publishProjectIcon(target.projectKey, icon.data, icon.mimeType)
          .catch((error: unknown) => {
            this.deps.logger?.warn(`Failed to publish wear icon for ${target.projectKey}`, error);
            return false;
          });
        if (ok) {
          this.publishedIcons.set(target.projectKey, icon.data);
        }
      }
    } finally {
      this.iconSyncRunning = false;
    }
  }

  private lookupProjectIcon(serverId: string, iconDir: string): Promise<WearProjectIcon | null> {
    const key = serverScopedKey(serverId, iconDir);
    const cached = this.iconLookups.get(key);
    if (cached) return cached;

    const client = this.deps.getClient(serverId);
    if (!client) {
      // Not cached: the server may simply not be connected yet, and "no client right
      // now" is not an answer about whether this project has an icon.
      return Promise.resolve(null);
    }

    // Deferred rather than called inline, so that a synchronous throw still evicts
    // *after* the set() below — otherwise the failure would cache itself as a
    // permanent "no icon" and never retry.
    const lookup = Promise.resolve()
      .then(() => client.requestProjectIcon(iconDir))
      .then((result): WearProjectIcon | null => result.icon)
      .catch((error: unknown) => {
        this.iconLookups.delete(key);
        this.deps.logger?.warn(`Failed to fetch project icon for ${iconDir}`, error);
        return null;
      });

    this.iconLookups.set(key, lookup);
    return lookup;
  }

  /**
   * Push transcript updates to whichever agents a watch currently has open.
   *
   * Runs on every store change, so it must stay cheap when nothing is leased — which
   * is the normal case, since a lease only exists while a watch screen is open.
   */
  private sweepTranscriptLeases(state: WearSnapshotInput[], now: number): void {
    if (this.transcriptLeases.size === 0) return;

    const activity = lastActivityIndex(state);
    for (const [key, lease] of this.transcriptLeases) {
      if (lease.expiresAt <= now) {
        this.dropTranscriptLease(key);
        continue;
      }

      const lastActivityAt = activity.get(key);
      if (lastActivityAt === undefined) {
        // The agent is gone from state — disconnected server, or archived away. The
        // watch has nothing to show either way, so stop fetching for it.
        this.dropTranscriptLease(key);
        continue;
      }

      if (lastActivityAt === lease.lastActivityAt) continue;
      this.scheduleTranscriptRefresh(key);
    }
  }

  private scheduleTranscriptRefresh(key: string): void {
    // One timer per agent is what coalesces the burst; the generation guard only
    // protects the content that lands, it doesn't stop redundant fetches.
    if (this.transcriptTimers.has(key)) return;

    const timer = setTimeout(() => {
      this.transcriptTimers.delete(key);
      if (this.disposed) return;

      // Recheck at fire time: a change arriving just before expiry would otherwise
      // fetch and publish for a watch that has already stopped renewing.
      const lease = this.transcriptLeases.get(key);
      if (!lease) return;
      if (lease.expiresAt <= (this.deps.now?.() ?? Date.now())) {
        this.transcriptLeases.delete(key);
        return;
      }

      void this.publishTranscript(lease.serverId, lease.agentId);
    }, COALESCE_MS);
    this.transcriptTimers.set(key, timer);
  }

  private dropTranscriptLease(key: string): void {
    this.transcriptLeases.delete(key);
    this.cancelTranscriptRefresh(key);
  }

  private cancelTranscriptRefresh(key: string): void {
    const timer = this.transcriptTimers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.transcriptTimers.delete(key);
  }

  /**
   * Start or extend the watch's lease on an agent's transcript.
   *
   * Renewal is just a new expiry: the recorded activity marker stays, so a re-request
   * that arrives mid-burst doesn't hide activity from the next sweep.
   */
  private renewTranscriptLease(serverId: string, agentId: string, now: number): void {
    const existing = this.transcriptLeases.get(serverScopedKey(serverId, agentId));
    if (existing) {
      existing.expiresAt = now + LEASE_MS;
      return;
    }
    this.transcriptLeases.set(serverScopedKey(serverId, agentId), {
      serverId,
      agentId,
      expiresAt: now + LEASE_MS,
      lastActivityAt: null,
    });
  }

  private async handleCommandPayload(payload: string): Promise<void> {
    const command = parseWearCommand(payload);
    if (!command) {
      this.deps.logger?.warn(`Ignoring unparseable wear command: ${payload.slice(0, 120)}`);
      return;
    }
    await this.execute(command);
  }

  /**
   * Fetch enough of an agent's timeline to fill a wrist and publish it.
   *
   * Pages backwards from the tail, because the newest turn is what the watch opened
   * the screen to read; older pages are prepended so the result stays oldest-first.
   */
  private async publishTranscript(serverId: string, agentId: string): Promise<void> {
    if (this.disposed) return;
    const key = serverScopedKey(serverId, agentId);

    // Whatever a pending refresh was going to fetch, this fetch covers.
    this.cancelTranscriptRefresh(key);

    // Read before the fetch, not after: activity that lands while we are paging must
    // still look like movement to the next sweep, or the last turn of a burst is the
    // one the watch never sees.
    const lease = this.transcriptLeases.get(key);
    if (lease) {
      lease.lastActivityAt = lastActivityIndex(this.deps.readState()).get(key) ?? null;
    }

    const client = this.deps.getClient(serverId);
    if (!client) {
      this.deps.logger?.warn(`No client for server ${serverId}; dropping wear transcript request`);
      return;
    }

    // Commands run concurrently, so two requests for the same agent race. Without a
    // generation the winner is whichever fetch finishes last, which means a slow
    // older fetch can overwrite a newer transcript with staler content.
    const generation = (this.transcriptGenerations.get(key) ?? 0) + 1;
    this.transcriptGenerations.set(key, generation);

    let pages: TimelinePage[];
    try {
      pages = await fetchTranscriptPages(client, agentId);
    } catch (error) {
      // Publishing nothing leaves the watch on its loading state, which is honest —
      // an empty transcript would read as "this agent has said nothing".
      this.deps.logger?.warn(`Failed to fetch transcript for agent ${agentId}`, error);
      return;
    }

    const transcript = buildWearTranscript(
      {
        agentId,
        serverId,
        items: pages.flatMap((page) => page.entries.map((entry) => entry.item)),
        // The oldest page we reached decides whether anything is still behind us.
        hasOlder: pages[0]?.hasOlder ?? false,
      },
      this.deps.now?.() ?? Date.now(),
    );

    if (this.transcriptGenerations.get(key) !== generation) {
      // A newer request for this agent already published; this result is older than
      // what the watch is showing, so landing it would be a visible regression.
      return;
    }

    // stop() can land mid-fetch, leaving no timer to cancel. Publishing now would
    // write over whatever a replacement bridge has already put on the wrist.
    if (this.disposed) return;

    // The DataItem path stays keyed by agent id alone — that is the wire contract the
    // watch reads, and it only ever talks to one phone.
    await this.deps.transport
      .publishTranscript(agentId, JSON.stringify(transcript))
      .catch((error: unknown) => {
        this.deps.logger?.warn(`Failed to publish wear transcript for agent ${agentId}`, error);
        return false;
      });
  }

  async execute(command: WearCommand): Promise<void> {
    if (command.kind === "refresh") {
      await this.publish({ force: true });
      return;
    }

    if (command.kind === "requestTranscript") {
      // The request is also the watch saying "I am looking at this now". Holding a
      // lease is what turns the next minute of activity into pushed updates instead
      // of the watch waiting for its own next poll.
      this.renewTranscriptLease(command.serverId, command.agentId, this.deps.now?.() ?? Date.now());
      // Returns without the forced republish below: reading a transcript changes
      // nothing about the agent, so there is no new state for the snapshot to carry.
      await this.publishTranscript(command.serverId, command.agentId);
      return;
    }

    if (
      command.kind === "startLiveVoice" ||
      command.kind === "stopLiveVoice" ||
      command.kind === "toggleLiveVoiceMute"
    ) {
      await this.executeLiveVoice(command);
      return;
    }

    const client = this.deps.getClient(command.serverId);
    if (!client) {
      // The watch already reported the send as delivered; there is nothing useful to
      // show it from here, so this is a log-and-drop. The next snapshot will show the
      // unchanged state, which is the honest outcome.
      this.deps.logger?.warn(`No client for server ${command.serverId}; dropping wear command`);
      return;
    }

    try {
      switch (command.kind) {
        case "sendPrompt":
          await client.sendAgentMessage(command.agentId, command.text);
          break;
        case "createAgent": {
          const config = this.deps.resolveNewAgentConfig(command.serverId, command.workspaceId);
          if (!config) {
            this.deps.logger?.warn(
              `No provider for workspace ${command.workspaceId}; dropping wear createAgent`,
            );
            break;
          }
          await client.createAgent({
            workspaceId: command.workspaceId,
            provider: config.provider as Parameters<DaemonClient["createAgent"]>[0]["provider"],
            cwd: config.cwd,
            initialPrompt: command.text,
          });
          break;
        }
        case "respondPermission":
          await client.respondToPermission(
            command.agentId,
            command.requestId,
            command.allow ? { behavior: "allow" } : { behavior: "deny" },
          );
          break;
        case "stopAgent":
          await client.cancelAgent(command.agentId);
          break;
      }
    } catch (error) {
      this.deps.logger?.warn(`Wear command ${command.kind} failed`, error);
    }

    // Push the resulting state promptly rather than waiting for the next store tick,
    // so the wrist reflects the action it just took.
    await this.publish({ force: true });
  }

  /**
   * Run a Live Voice command from the watch.
   *
   * Every path ends in a publish, including the failures: a start that is refused
   * (microphone busy, host gone) leaves the runtime in `error` with a code, and
   * that is exactly what the watch needs on screen instead of a spinner.
   */
  private async executeLiveVoice(
    command: Extract<
      WearCommand,
      { kind: "startLiveVoice" | "stopLiveVoice" | "toggleLiveVoiceMute" }
    >,
  ): Promise<void> {
    const liveVoice = this.deps.liveVoice;
    if (!liveVoice) {
      this.deps.logger?.warn(`No live voice runtime; dropping wear command ${command.kind}`);
      return;
    }

    try {
      switch (command.kind) {
        case "startLiveVoice":
          await liveVoice.start(command.serverId);
          break;
        case "stopLiveVoice":
          await liveVoice.stop();
          break;
        case "toggleLiveVoiceMute":
          liveVoice.toggleMute();
          break;
      }
    } catch (error) {
      // The runtime has already recorded the failure in its own snapshot, so the
      // publish below carries it to the wrist; this is only for the phone's log.
      this.deps.logger?.warn(`Wear command ${command.kind} failed`, error);
    }

    await this.publishLiveVoice();
  }
}

/**
 * True when anything other than the transcript moved between two Live Voice
 * states — that is, when the change alters what the watch's controls say or do.
 */
function isLiveVoiceControlChange(previous: WearLiveVoiceState, next: WearLiveVoiceState): boolean {
  return (
    stableLiveVoiceKey({ ...next, transcripts: previous.transcripts }) !==
    stableLiveVoiceKey(previous)
  );
}

/**
 * Join a server id to something only unique within that server — an agent id, or a
 * directory path. NUL as the separator because it can appear in neither half, so
 * distinct pairs can never collapse into the same key.
 */
function serverScopedKey(serverId: string, agentId: string): string {
  return `${serverId}\u0000${agentId}`;
}

/** One project's icon as the daemon serves it: base64 bytes plus their mime type. */
type WearProjectIcon = NonNullable<Awaited<ReturnType<DaemonClient["requestProjectIcon"]>>["icon"]>;

interface IconTarget {
  serverId: string;
  /** Exactly what the snapshot publishes, because that is what the watch looks up. */
  projectKey: string;
  /** Directory the daemon scans for an icon file. */
  iconDir: string;
}

/**
 * One icon target per distinct project in the snapshot.
 *
 * Deduped by projectKey rather than by workspace: ten worktrees of the same repo are
 * one icon on the wrist, and the watch keys its cache the same way. The scan
 * directory mirrors the phone sidebar's `iconWorkingDir` — the project root, which
 * for a Paseo worktree is the main checkout rather than the throwaway worktree, so
 * every workspace of a project resolves the same file.
 */
function collectIconTargets(state: WearSnapshotInput[]): IconTarget[] {
  const targets = new Map<string, IconTarget>();
  for (const input of state) {
    for (const descriptor of input.workspaces.values()) {
      // Same exclusion the snapshot makes: a workspace on its way out isn't on the
      // watch, so its project doesn't need an icon there either.
      if (descriptor.archivingAt) continue;

      const projectKey = descriptor.project?.projectKey ?? descriptor.projectId;
      if (!projectKey || targets.has(projectKey)) continue;

      const iconDir = descriptor.projectRootPath?.trim() || descriptor.workspaceDirectory?.trim();
      if (!iconDir) continue;

      targets.set(projectKey, { serverId: input.serverId, projectKey, iconDir });
    }
  }
  return Array.from(targets.values());
}

function lastActivityIndex(state: WearSnapshotInput[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const input of state) {
    for (const agent of input.agents) {
      index.set(serverScopedKey(input.serverId, agent.id), agent.lastActivityAt.getTime());
    }
  }
  return index;
}

type TimelineClient = Pick<DaemonClient, "fetchAgentTimeline">;
type TimelinePage = Awaited<ReturnType<TimelineClient["fetchAgentTimeline"]>>;

/**
 * Walk backwards from the tail until we have enough entries, run out of history, or
 * hit the request cap. Returned oldest page first.
 *
 * Counts only entries that survive projection. Raw daemon entries would overcount a
 * reasoning-heavy history badly — a page can be almost entirely reasoning and todos,
 * none of which reaches the watch — and the walk would stop with a nearly empty
 * transcript while it still had requests left to spend.
 */
async function fetchTranscriptPages(
  client: TimelineClient,
  agentId: string,
): Promise<TimelinePage[]> {
  const pages: TimelinePage[] = [];
  let total = 0;
  let epoch: string | null = null;

  for (let request = 0; request < MAX_TRANSCRIPT_REQUESTS; request += 1) {
    // The first request omits the cursor entirely: that is what asks for the tail.
    const cursor = pages[0]?.startCursor;
    const page = await client.fetchAgentTimeline(
      agentId,
      cursor
        ? { projection: "projected", direction: "before", cursor, limit: TRANSCRIPT_PAGE_SIZE }
        : { projection: "projected", limit: TRANSCRIPT_PAGE_SIZE },
    );

    if (epoch === null) {
      epoch = page.epoch;
    } else if (page.reset || page.staleCursor || page.epoch !== epoch) {
      // The timeline was rewound or rehydrated mid-walk, so our cursor is pointing
      // into a history that no longer exists and the daemon answered with a fresh
      // tail instead. Splicing that onto what we already have would duplicate turns
      // and resurrect rewound-away content, so stop and keep the consistent prefix.
      break;
    }

    pages.unshift(page);
    total += page.entries.filter((entry) => isTranscriptEntry(entry.item)).length;

    if (total >= MAX_TRANSCRIPT_ENTRIES || !page.hasOlder || !page.startCursor) break;
  }

  return pages;
}

/**
 * Identity key for change detection. Excludes `updatedAt`, which changes on every
 * build and would defeat the comparison entirely.
 */
function stableSnapshotKey(snapshot: WearSnapshot): string {
  return JSON.stringify({ v: snapshot.v, workspaces: snapshot.workspaces });
}
