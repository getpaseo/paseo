export type CheckStatus = "ok" | "warn" | "error";

export interface DoctorCheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheckResult[];
  summary: { ok: number; warn: number; error: number };
  timestamp: string;
}
