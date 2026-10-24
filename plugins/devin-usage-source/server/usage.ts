import type { UsageInput } from "../shared/input.js";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  toneFromUsedPct,
  unavailable,
  type UsageAccount,
  windowFromUsedPct,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";

/**
 * Devin's CLI (`devin`, shared by Devin Desktop) stores its login in
 * `~/.local/share/devin/credentials.toml`:
 *
 *   windsurf_api_key = "devin-session-token$<jwt>"
 *   api_server_url   = "https://server.codeium.com"
 *
 * Quota comes from the same SeatManagement Connect call the CLI makes. The
 * response is proto-only, so the fields used by the usage card are decoded here:
 *
 *   GetUserStatusResponse {
 *     user_status = 1 {
 *       plan_status = 13 {
 *         plan = 1 { name = 2 }
 *         daily_quota_remaining_percent = 14
 *         weekly_quota_remaining_percent = 15
 *         daily_quota_reset_at_unix = 17
 *         weekly_quota_reset_at_unix = 18
 *       }
 *     }
 *     plan_info = 2 { name = 2 }
 *   }
 */

const DEFAULT_API_SERVER = "https://server.codeium.com";
const CLIENT_VERSION = "0.0.0-dev";
const GET_USER_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";
const REQUEST_TIMEOUT_MS = 15_000;

interface DevinCredentials {
  apiKey: string;
  apiServer: string;
}

interface DevinQuota {
  planName: string | null;
  dailyRemainingPct: number | null;
  weeklyRemainingPct: number | null;
  dailyResetsAt: string | null;
  weeklyResetsAt: string | null;
}

interface ProtoField {
  no: number;
  wire: number;
  value: number;
  bytes: Uint8Array;
}

/** The credential file is TOML, but only these two flat string values matter. */
function parseCredentials(text: string): DevinCredentials | null {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*"(.*)"\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) values.set(match[1], match[2]);
  }
  const apiKey = values.get("windsurf_api_key")?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    apiServer: values.get("api_server_url")?.trim() || DEFAULT_API_SERVER,
  };
}

function envApiServer(): string {
  return (
    process.env.DEVIN_API_SERVER_URL?.trim() ||
    process.env.WINDSURF_API_SERVER_URL?.trim() ||
    DEFAULT_API_SERVER
  );
}

async function readCredentials(input: UsageInput): Promise<DevinCredentials | null> {
  if (input.store === "env") {
    const apiKey = process.env[input.locator]?.trim();
    return apiKey ? { apiKey, apiServer: envApiServer() } : null;
  }
  const text = await fs.readFile(input.locator, "utf8").catch(() => null);
  return text ? parseCredentials(text) : null;
}

function credentialPaths(): string[] {
  const paths = new Set<string>();
  const xdgData = process.env.XDG_DATA_HOME;
  if (xdgData) paths.add(join(xdgData, "devin", "credentials.toml"));
  paths.add(join(homedir(), ".local", "share", "devin", "credentials.toml"));
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) paths.add(join(localAppData, "devin", "credentials.toml"));
  const appData = process.env.APPDATA;
  if (appData) paths.add(join(appData, "devin", "credentials.toml"));
  return [...paths];
}

export async function discover(): Promise<UsageAccount[]> {
  const candidates: UsageInput[] = ["DEVIN_API_KEY", "WINDSURF_API_KEY"].map((locator) => ({
    store: "env",
    locator,
  }));
  candidates.push(...credentialPaths().map((locator) => ({ store: "file" as const, locator })));
  for (const input of candidates) {
    if (await readCredentials(input)) return [{ key: "default", input }];
  }
  return [];
}

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  bytes.push(remaining);
  return bytes;
}

function encodeStringField(fieldNo: number, value: string): number[] {
  const body = [...Buffer.from(value, "utf8")];
  return [...encodeVarint((fieldNo << 3) | 2), ...encodeVarint(body.length), ...body];
}

/**
 * Metadata mirrors the CLI request: the API key travels in field 3, and the
 * server accepts the same shape for any client name/version.
 */
function encodeRequest(apiKey: string): Uint8Array {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const metadata = [
    ...encodeStringField(1, "chisel"),
    ...encodeStringField(2, CLIENT_VERSION),
    ...encodeStringField(3, apiKey),
    ...encodeStringField(4, "en"),
    ...encodeStringField(5, platform),
    ...encodeStringField(7, CLIENT_VERSION),
    ...encodeStringField(12, "chisel"),
  ];
  return Uint8Array.from([
    ...encodeVarint((1 << 3) | 2),
    ...encodeVarint(metadata.length),
    ...metadata,
  ]);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.length);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function readVarint(bytes: Uint8Array, start: number): [number, number] | null {
  let value = 0;
  let shift = 1;
  let offset = start;
  while (offset < bytes.length) {
    const byte = bytes[offset]!;
    offset += 1;
    value += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) return [value, offset];
    shift *= 0x80;
    if (shift > 2 ** 63) return null;
  }
  return null;
}

function parseFields(bytes: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    if (!key) break;
    offset = key[1];
    const no = Math.floor(key[0] / 8);
    const wire = key[0] % 8;
    if (no === 0) break;
    if (wire === 0) {
      const value = readVarint(bytes, offset);
      if (!value) break;
      offset = value[1];
      fields.push({ no, wire, value: value[0], bytes: new Uint8Array() });
    } else if (wire === 2) {
      const length = readVarint(bytes, offset);
      if (!length) break;
      const end = length[1] + length[0];
      if (end > bytes.length) break;
      fields.push({ no, wire, value: 0, bytes: bytes.subarray(length[1], end) });
      offset = end;
    } else if (wire === 1) {
      if (offset + 8 > bytes.length) break;
      offset += 8;
    } else if (wire === 5) {
      if (offset + 4 > bytes.length) break;
      offset += 4;
    } else break;
  }
  return fields;
}

function field(fields: ProtoField[], no: number): ProtoField | undefined {
  return fields.find((candidate) => candidate.no === no);
}

function message(bytes: Uint8Array | undefined): ProtoField[] {
  return bytes ? parseFields(bytes) : [];
}

function numberAt(fields: ProtoField[], no: number): number | null {
  const match = field(fields, no);
  if (!match) return null;
  if (match.wire === 0) return match.value;
  return null;
}

function textAt(fields: ProtoField[], no: number): string | null {
  const match = field(fields, no);
  if (match?.wire !== 2 || match.bytes.length === 0) return null;
  const text = Buffer.from(match.bytes).toString("utf8").trim();
  return text.length > 0 ? text : null;
}

function percent(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

function isoFromUnixSeconds(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Exported for tests; decodes one `GetUserStatusResponse` payload. */
export function decodeQuotaResponse(bytes: Uint8Array): DevinQuota {
  const top = parseFields(bytes);
  const userStatus = message(field(top, 1)?.bytes);
  const planInfo = message(field(top, 2)?.bytes);
  const planStatus = message(field(userStatus, 13)?.bytes);
  const plan = message(field(planStatus, 1)?.bytes);

  return {
    planName: textAt(planInfo, 2) ?? textAt(plan, 2),
    dailyRemainingPct: percent(numberAt(planStatus, 14)),
    weeklyRemainingPct: percent(numberAt(planStatus, 15)),
    dailyResetsAt: isoFromUnixSeconds(numberAt(planStatus, 17)),
    weeklyResetsAt: isoFromUnixSeconds(numberAt(planStatus, 18)),
  };
}

function quotaWindows(quota: DevinQuota): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const [id, label, shortLabel, remaining, resetsAt, summary] of [
    ["daily", "Daily limit", "day", quota.dailyRemainingPct, quota.dailyResetsAt, true],
    ["weekly", "Weekly limit", "wk", quota.weeklyRemainingPct, quota.weeklyResetsAt, false],
  ] as const) {
    if (remaining === null) continue;
    const usedPct = 100 - remaining;
    windows.push(
      windowFromUsedPct({
        id,
        label,
        shortLabel,
        summary,
        utilizationPct: usedPct,
        resetsAt,
        tone: toneFromUsedPct(usedPct),
      }),
    );
  }
  return windows;
}

function endpointFor(apiServer: string): string | null {
  try {
    const url = new URL(apiServer);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}${GET_USER_STATUS_PATH}`;
  } catch {
    return null;
  }
}

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  const credentials = await readCredentials(input);
  if (!credentials) throw new Error("Devin login store no longer exists");

  const endpoint = endpointFor(credentials.apiServer);
  if (!endpoint) throw new Error("Devin API server URL is not HTTP(S)");

  const res = await fetchApi(endpoint, {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Authorization: `Basic ${Buffer.from(`${credentials.apiKey}:`).toString("base64")}`,
      "Content-Type": "application/proto",
      "Connect-Protocol-Version": "1",
    },
    body: toArrayBuffer(encodeRequest(credentials.apiKey)),
  });

  if (res.status === 401 || res.status === 403)
    return unavailable({ kind: "rejected", status: res.status });
  if (!res.ok) throw new Error(`Devin usage API returned ${res.status}`);

  const quota = decodeQuotaResponse(new Uint8Array(await res.arrayBuffer()));
  const windows = quotaWindows(quota);
  if (!quota.planName && windows.length === 0)
    return unavailable({ kind: "no_quota", detail: "Devin returned no plan quota" });

  return {
    status: "available",
    planLabel: quota.planName ?? undefined,
    windows,
    balances: [],
    details: [],
  };
}
