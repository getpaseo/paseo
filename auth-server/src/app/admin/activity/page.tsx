"use client";

import { useEffect, useState } from "react";

interface ActivityEntry {
  id: string;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  details: Record<string, any> | null;
  createdAt: string;
}

export default function AdminActivityPage() {
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), limit: "50" });
    fetch(`/api/admin/activity?${params}`)
      .then((res) => res.json())
      .then((data) => {
        setActivity(data.activity);
        setTotalPages(data.pagination.pages);
      });
  }, [page]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Activity Log</h1>

      <div className="space-y-2">
        {activity.map((entry) => (
          <div
            key={entry.id}
            className="flex items-start justify-between rounded-lg border border-border bg-card px-4 py-3"
          >
            <div>
              <p className="text-sm font-medium text-foreground">{entry.action}</p>
              <p className="text-xs text-muted-foreground">
                {entry.userName || entry.userEmail || "System"} &middot;{" "}
                {entry.resourceType && `${entry.resourceType}:${entry.resourceId}`}
              </p>
              {entry.details && (
                <pre className="mt-1 text-xs text-muted-foreground">
                  {JSON.stringify(entry.details, null, 2)}
                </pre>
              )}
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">
              {new Date(entry.createdAt).toLocaleString()}
            </span>
          </div>
        ))}

        {activity.length === 0 && (
          <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="rounded-md border border-border px-3 py-1 text-sm disabled:opacity-50"
          >
            Previous
          </button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="rounded-md border border-border px-3 py-1 text-sm disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
