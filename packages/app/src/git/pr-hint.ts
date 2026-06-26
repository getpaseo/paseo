export interface PrHint {
  url: string;
  number: number;
  state: "open" | "merged" | "closed";
  checks?: Array<{ name: string; status: string; url: string | null }>;
  checksStatus?: "none" | "pending" | "success" | "failure";
  reviewDecision?: "approved" | "changes_requested" | "pending" | null;
}

interface PrStatusLike {
  url: string;
  state: string;
  isMerged: boolean;
  checks?: Array<{ name: string; status: string; url: string | null }>;
  checksStatus?: string;
  reviewDecision?: string | null;
}

function parsePullRequestNumber(url: string): number | null {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\/pull\/(\d+)(?:\/|$)/);
    if (!match) {
      return null;
    }

    const number = Number.parseInt(match[1], 10);
    return Number.isFinite(number) ? number : null;
  } catch {
    return null;
  }
}

export function selectPrHintFromStatus(status: PrStatusLike | null | undefined): PrHint | null {
  if (!status?.url) {
    return null;
  }

  const number = parsePullRequestNumber(status.url);
  if (number === null) {
    return null;
  }

  let state: "merged" | "open" | "closed";
  if (status.isMerged || status.state === "merged") state = "merged";
  else if (status.state === "open") state = "open";
  else state = "closed";

  return {
    url: status.url,
    number,
    state,
    checks: status.checks,
    checksStatus: status.checksStatus as PrHint["checksStatus"],
    reviewDecision: status.reviewDecision as PrHint["reviewDecision"],
  };
}
