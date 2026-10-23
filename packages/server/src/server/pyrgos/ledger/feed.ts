import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import type { LedgerItem } from "./ledger.js";

const MAX_ANNOUNCE_CHARS = 400;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 5;
export const HOLD_SECONDS = 20;

export const SPEAKERS = ["user", "assistant", "overseer", "system", "action"] as const;
export type Speaker = (typeof SPEAKERS)[number];

const TranscriptRowSchema = z.object({
  ts: z.string(),
  speaker: z.enum(SPEAKERS),
  text: z.string(),
});

const ReplyRowSchema = z.object({ ts: z.string().optional(), text: z.string() });

export interface VoiceSession {
  readonly path: string;
  readonly repliesPath: string;
  append(speaker: Speaker, text: string): Promise<number>;
}

export interface CreateSessionInput {
  dir: string;
  session: string;
  now?: () => Date;
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.close();
      return () => rm(lockPath, { force: true });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      const age = await stat(lockPath).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0,
      );
      if (age > LOCK_STALE_MS) await rm(lockPath, { force: true });
      else await sleep(LOCK_RETRY_MS);
    }
  }
}

async function endsUnterminated(path: string): Promise<boolean> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.length > 0 && !text.endsWith("\n");
}

async function countLines(path: string): Promise<number> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.length > 0).length;
}

export function createVoiceSession(input: CreateSessionInput): VoiceSession {
  const path = join(input.dir, `${input.session}.jsonl`);
  const repliesPath = join(input.dir, `${input.session}.replies.jsonl`);
  const now = input.now ?? (() => new Date());
  let queue: Promise<unknown> = Promise.resolve();

  async function write(speaker: Speaker, text: string): Promise<number> {
    await mkdir(dirname(path), { recursive: true });
    const release = await acquireLock(`${path}.lock`);
    try {
      const line = (await countLines(path)) + 1;
      const row = TranscriptRowSchema.parse({ ts: now().toISOString(), speaker, text });
      const lead = (await endsUnterminated(path)) ? "\n" : "";
      await appendFile(path, `${lead}${JSON.stringify(row)}\n`, "utf8");
      return line;
    } finally {
      await release();
    }
  }

  function append(speaker: Speaker, text: string): Promise<number> {
    const next = queue.then(() => write(speaker, text));
    queue = next.catch(() => undefined);
    return next;
  }

  return { path, repliesPath, append };
}

export function announceLine({ item, ref }: { item: string; ref: string }): string {
  const text = item.split(/\s+/).filter(Boolean).join(" ");
  const head = "[voice] ACTION: ";
  const line = `${head}${text} (transcript: ${ref})`;
  if (line.length <= MAX_ANNOUNCE_CHARS) return line;
  const maxRef = Math.floor(MAX_ANNOUNCE_CHARS / 2);
  const shortRef = ref.length > maxRef ? `…${ref.slice(-(maxRef - 1))}` : ref;
  const tail = ` (transcript: ${shortRef})`;
  const room = MAX_ANNOUNCE_CHARS - head.length - tail.length - 1;
  return `${head}${text.slice(0, Math.max(room, 0))}…${tail}`;
}

export type Exec = (file: string, args: string[]) => Promise<void>;

const execFileAsync = promisify(execFile);

export async function execFileExec(file: string, args: string[]): Promise<void> {
  await execFileAsync(file, args);
}

export interface AnnouncerInput {
  session: VoiceSession;
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
  inboxPath?: string;
}

export function createAnnouncer(input: AnnouncerInput): (item: LedgerItem) => Promise<void> {
  const env = input.env ?? process.env;
  const exec = input.exec ?? execFileExec;
  const inboxPath = input.inboxPath ?? join(homedir(), "pc-inbox.md");

  return async function announce(item) {
    const row = await input.session.append("action", item.item);
    const line = announceLine({ item: item.item, ref: `${input.session.path}#${row}` });
    const surface = env.VOICE_OVERSEER_SURFACE;
    if (surface) {
      await exec("wmux", ["send", surface, line]);
      return;
    }
    await appendFile(inboxPath, `${line}\n`, "utf8");
  };
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function digest(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

type ReadText = (path: string) => Promise<string>;

const readUtf8: ReadText = (path) => readFile(path, "utf8");

export class ReplyWatcher {
  private offset = 0;
  private consumed = digest("");

  constructor(
    private readonly path: string,
    private readonly read: ReadText = readUtf8,
  ) {}

  async poll(): Promise<string[]> {
    let raw = "";
    try {
      raw = await this.read(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (raw.length < this.offset || digest(raw.slice(0, this.offset)) !== this.consumed) {
      this.offset = 0;
    }
    const unread = raw.slice(this.offset);
    const end = unread.lastIndexOf("\n");
    if (end < 0) return [];
    this.offset += end + 1;
    this.consumed = digest(raw.slice(0, this.offset));
    const replies: string[] = [];
    for (const line of unread.slice(0, end).split("\n")) {
      if (!line.trim()) continue;
      const parsed = ReplyRowSchema.safeParse(parseJsonLine(line));
      const text = parsed.success ? parsed.data.text.trim() : "";
      if (text) replies.push(text);
    }
    return replies;
  }
}

export type BusyFlag = "user" | "bot" | "llm";

export class TurnGate {
  private readonly busy: Record<BusyFlag, boolean> = { user: false, bot: false, llm: false };
  private holdUntil = 0;

  constructor(private readonly clock: () => number = Date.now) {}

  set(flag: BusyFlag, value: boolean): void {
    this.busy[flag] = value;
  }

  hold(seconds: number = HOLD_SECONDS): void {
    this.holdUntil = Math.max(this.holdUntil, this.clock() + seconds * 1000);
  }

  idle(): boolean {
    return !this.busy.user && !this.busy.bot && !this.busy.llm && this.clock() >= this.holdUntil;
  }
}

export function replyLine(text: string): string {
  return `The overseer says: ${text}`;
}

export interface ReplyPumpInput {
  watcher: ReplyWatcher;
  gate: TurnGate;
  session: VoiceSession;
  speak: (line: string) => Promise<void>;
}

export class ReplyPump {
  private readonly pending: { text: string; logged: boolean }[] = [];

  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly input: ReplyPumpInput) {}

  pump(): Promise<string[]> {
    const next = this.queue.then(() => this.drain());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async drain(): Promise<string[]> {
    for (const text of await this.input.watcher.poll()) this.pending.push({ text, logged: false });
    const spoken: string[] = [];
    while (this.input.gate.idle()) {
      const reply = this.pending[0];
      if (reply === undefined) break;
      if (!reply.logged) {
        await this.input.session.append("overseer", reply.text);
        reply.logged = true;
      }
      await this.input.speak(replyLine(reply.text));
      this.pending.shift();
      spoken.push(reply.text);
    }
    return spoken;
  }
}
