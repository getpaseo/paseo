import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { fetchSkillBody } from "@/lib/library/catalog/github-skills";
import { resolveSkillRawUrl } from "@/lib/library/catalog/skills-sh";

/**
 * Streams the raw SKILL.md content for a recommended skill entry. Separate
 * from the list endpoint so the list stays small (~1KB per item) and only
 * the entry the user actually opens pulls the full body.
 *
 * Accepts `?url=<raw.githubusercontent.com/...>` — validated against an
 * allow-list of known hosts so we don't turn this into an open redirect /
 * SSRF hazard.
 */
const ALLOWED_HOSTS = new Set([
  "raw.githubusercontent.com",
  "skills.sh",
  "www.skills.sh",
]);

export async function GET(request: NextRequest) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  if (!target) return NextResponse.json({ error: "url required" }, { status: 400 });
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    return NextResponse.json({ error: "Host not allowed" }, { status: 400 });
  }
  let body = await fetchSkillBody(parsed.toString());
  if (body === null && parsed.hostname === "raw.githubusercontent.com") {
    // skills.sh entries set an optimistic `skills/<id>/SKILL.md` URL during
    // normalization, but many repos use `.skills/`, `.agents/skills/`, or a
    // bare `<id>/` layout. Probe siblings and re-fetch on a hit.
    const parts = parsed.pathname.split("/").filter(Boolean);
    // /<owner>/<repo>/HEAD/<...path>
    if (parts.length >= 5 && parts[2] === "HEAD") {
      const owner = parts[0]!;
      const repo = parts[1]!;
      const skillId = parts[parts.length - 2]!;
      const resolved = await resolveSkillRawUrl(`${owner}/${repo}`, skillId);
      if (resolved) body = await fetchSkillBody(resolved);
    }
  }
  if (body === null) {
    return NextResponse.json({ error: "Failed to fetch body" }, { status: 502 });
  }
  return NextResponse.json({ body });
}
