import { OmpNoticeEventSchema } from "./rpc-types.js";

// OMP 18.x announces device mounts as an info notice `xd://: mounted a, b; unmounted c` with
// source `xdev`. Each OMP process diffs against the tools it had at startup, so every relaunch of
// the same session (idle collection, reload, mode change) announces again every MCP server that
// connects after OMP's startup wait. A relaunch never reports a device that went missing while
// no process ran, and has no RPC that lists mounted devices, so a device that vanishes and later
// remounts in a new process looks identical to one that was present all along.
const MOUNT_NOTICE_PREFIX = "xd://: ";
const MOUNT_NOTICE_SOURCE = "xdev";
const MOUNT_NOTICE_LEVEL = "info";
const MOUNTED_PREFIX = "mounted ";
const UNMOUNTED_PREFIX = "unmounted ";

export interface OmpMountNotice {
  mounted: readonly string[];
  unmounted: readonly string[];
}

function parseNames(list: string): string[] | null {
  const names = list.split(",").map((name) => name.trim());
  return names.every((name) => name.length > 0) ? names : null;
}

/** Reads an OMP `notice` event as an xd:// mount change, or null for any other notice. */
export function parseOmpMountNotice(event: unknown): OmpMountNotice | null {
  const parsed = OmpNoticeEventSchema.safeParse(event);
  if (!parsed.success) return null;
  const { level, message, source } = parsed.data;
  if (level !== MOUNT_NOTICE_LEVEL) return null;
  if (source !== undefined && source !== MOUNT_NOTICE_SOURCE) return null;
  if (!message.startsWith(MOUNT_NOTICE_PREFIX)) return null;

  const mounted: string[] = [];
  const unmounted: string[] = [];
  for (const segment of message.slice(MOUNT_NOTICE_PREFIX.length).split(";")) {
    const part = segment.trim();
    let target: string[];
    let names: string[] | null;
    if (part.startsWith(UNMOUNTED_PREFIX)) {
      target = unmounted;
      names = parseNames(part.slice(UNMOUNTED_PREFIX.length));
    } else if (part.startsWith(MOUNTED_PREFIX)) {
      target = mounted;
      names = parseNames(part.slice(MOUNTED_PREFIX.length));
    } else {
      return null;
    }
    if (!names) return null;
    target.push(...names);
  }
  return mounted.length > 0 || unmounted.length > 0 ? { mounted, unmounted } : null;
}

type OmpMountState = "mounted" | "unmounted";

/** The session that delivered a timeline row. A ledger keeps only rows its projection holds. */
export type OmpMountNoticeDeliverer = object;

interface OmpAnnouncedMount {
  state: OmpMountState;
  deliverer: OmpMountNoticeDeliverer;
}

/** The last xd:// state one agent's projected timeline shows for each device. */
export class OmpMountNoticeLedger {
  private readonly announced = new Map<string, OmpAnnouncedMount>();

  /** Reports whether the notice changes any device state the projection shows. */
  announces(notice: OmpMountNotice): boolean {
    return (
      notice.mounted.some((name) => this.announced.get(name)?.state !== "mounted") ||
      notice.unmounted.some((name) => this.announced.get(name)?.state !== "unmounted")
    );
  }

  /** Records a row the deliverer added to the projection; it shows every device it names. */
  recordDelivered(notice: OmpMountNotice, deliverer: OmpMountNoticeDeliverer): void {
    for (const name of notice.mounted) this.announced.set(name, { state: "mounted", deliverer });
    for (const name of notice.unmounted) {
      this.announced.set(name, { state: "unmounted", deliverer });
    }
  }

  /**
   * Keeps only rows the deliverer added. A session streams provider history only to seed a fresh
   * projection, which holds that history plus the rows this session already delivered into it.
   */
  retainDeliveredBy(deliverer: OmpMountNoticeDeliverer): void {
    for (const [name, mount] of this.announced) {
      if (mount.deliverer !== deliverer) this.announced.delete(name);
    }
  }

  clear(): void {
    this.announced.clear();
  }

  get size(): number {
    return this.announced.size;
  }
}

/**
 * Mount ledgers keyed by Paseo agent id. The agent's retained projection outlives one OMP
 * process and one Paseo session, so its ledger must too.
 */
export class OmpMountNoticeLedgers {
  private readonly byAgentId = new Map<string, OmpMountNoticeLedger>();

  forAgent(agentId: string): OmpMountNoticeLedger {
    let ledger = this.byAgentId.get(agentId);
    if (!ledger) {
      ledger = new OmpMountNoticeLedger();
      this.byAgentId.set(agentId, ledger);
    }
    return ledger;
  }

  /** The agent's whole projection is about to be replaced from provider history. */
  forget(agentId: string): void {
    this.byAgentId.delete(agentId);
  }

  /** The agent's projection is being seeded from provider history by this deliverer. */
  seedFromHistory(agentId: string, deliverer: OmpMountNoticeDeliverer): void {
    const ledger = this.byAgentId.get(agentId);
    if (!ledger) return;
    ledger.retainDeliveredBy(deliverer);
    if (ledger.size === 0) this.byAgentId.delete(agentId);
  }
}
