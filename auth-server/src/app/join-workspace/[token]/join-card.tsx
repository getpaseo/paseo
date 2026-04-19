"use client";

/**
 * JoinCard — Meet-style pre-join UI for workspace share links.
 *
 * Left: LiveKit PreJoin (live preview + device pickers + cam/mic toggles).
 * Right: workspace metadata. The LiveKit Join button forwards choices to the
 * target app via query params — localStorage doesn't cross origins.
 */

import "@livekit/components-styles";
import { useCallback, useEffect, useState } from "react";
import { PreJoin, type LocalUserChoices } from "@livekit/components-react";

interface RoomParticipant {
  identity: string;
  name: string;
  avatarUrl: string | null;
}

interface JoinCardProps {
  token: string;
  workspaceName: string;
  projectName: string;
  accessLevel: "read_only" | "full_access";
  ownerName: string;
  ownerImage: string | null;
  viewerName: string;
  viewerImage: string | null;
  webAppUrl: string | null;
  sessionToken: string;
}

export function JoinCard({
  token,
  workspaceName,
  projectName,
  accessLevel,
  ownerName,
  viewerName,
  webAppUrl,
  sessionToken,
}: JoinCardProps) {
  const accessBadge =
    accessLevel === "full_access"
      ? { label: "Full access", className: "border-primary/20 bg-primary/10 text-primary" }
      : { label: "View only", className: "border-border bg-muted text-muted-foreground" };

  // Poll the room participant list so the user can see who's already in the
  // session before joining. 3s cadence keeps it fresh without hammering.
  const [participants, setParticipants] = useState<RoomParticipant[]>([]);
  useEffect(() => {
    if (!sessionToken || !token) return;
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const res = await fetch(
          `/api/livekit/participants?room=${encodeURIComponent(token)}`,
          { headers: { Authorization: `Bearer ${sessionToken}` } },
        );
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { participants: RoomParticipant[] };
        if (!cancelled) setParticipants(data.participants ?? []);
      } catch {}
    };
    fetchOnce();
    const id = window.setInterval(fetchOnce, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [token, sessionToken]);

  const handleSubmit = useCallback(
    (choices: LocalUserChoices) => {
      if (!webAppUrl) return;
      const p = new URLSearchParams();
      if (!choices.videoEnabled) p.set("video", "0");
      if (!choices.audioEnabled) p.set("audio", "0");
      if (choices.videoDeviceId) p.set("videoDevice", choices.videoDeviceId);
      if (choices.audioDeviceId) p.set("audioDevice", choices.audioDeviceId);
      const url = `${webAppUrl}/join-workspace/${token}?st=${encodeURIComponent(sessionToken)}${
        p.toString() ? `&${p.toString()}` : ""
      }`;
      window.location.href = url;
    },
    [webAppUrl, token, sessionToken],
  );

  return (
    <div className="w-full max-w-4xl px-4" data-lk-theme="default">
      {/* Hide LiveKit's username input (identity comes from auth) and tint
          the Join button with Hubcode magenta. */}
      <style>{`
        .lk-prejoin .lk-username-container input,
        .lk-prejoin input[id="username"],
        .lk-prejoin input[name="username"] { display: none !important; }
        .lk-prejoin .lk-button.lk-join-button {
          background-color: #C4198B !important;
          border-color: #C4198B !important;
          color: #fff !important;
        }
        .lk-prejoin .lk-button.lk-join-button:hover {
          background-color: #a8137a !important;
        }
      `}</style>
      <div className="grid gap-6 md:grid-cols-[1.3fr_1fr] rounded-2xl border border-border bg-card p-6 shadow-2xl shadow-black/40">
        <div>
          <PreJoin
            defaults={{ username: viewerName, videoEnabled: true, audioEnabled: true }}
            onSubmit={handleSubmit}
            joinLabel="Join session"
          />
        </div>

        <div className="flex flex-col justify-between gap-5">
          <div className="space-y-4">
            <div
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${accessBadge.className}`}
            >
              {accessBadge.label}
            </div>
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold text-foreground">Ready to join?</h1>
              <p className="text-sm text-muted-foreground">
                <span className="text-foreground font-medium">{ownerName}</span> is sharing a
                workspace with you.
              </p>
            </div>

            <dl className="divide-y divide-border rounded-md border border-border bg-background/40 text-sm">
              <Row label="Project" value={projectName} />
              <Row label="Workspace" value={workspaceName} />
              <Row
                label="Access"
                value={accessLevel === "full_access" ? "Can interact" : "View only"}
              />
              <Row label="Shared by" value={ownerName} />
            </dl>

            <ParticipantList participants={participants} />
          </div>
          {!webAppUrl && (
            <p className="text-center text-xs text-destructive">
              The web app URL is not configured on this server.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function ParticipantList({ participants }: { participants: RoomParticipant[] }) {
  const count = participants.length;
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {count === 0
          ? "No one is in the session yet"
          : `In the session · ${count}`}
      </p>
      {count > 0 && (
        <ul className="flex flex-col gap-2 rounded-md border border-border bg-background/40 p-2">
          {participants.map((p) => (
            <li key={p.identity} className="flex items-center gap-2 text-sm">
              <Avatar name={p.name} avatarUrl={p.avatarUrl} />
              <span className="text-foreground truncate">{p.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Avatar({ name, avatarUrl }: { name: string; avatarUrl: string | null }) {
  const initial = (name.trim().charAt(0) || "?").toUpperCase();
  if (avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={avatarUrl}
        alt={name}
        className="h-7 w-7 rounded-full object-cover border border-border"
      />
    );
  }
  return (
    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
      {initial}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground truncate pl-3 text-right">{value}</dd>
    </div>
  );
}
