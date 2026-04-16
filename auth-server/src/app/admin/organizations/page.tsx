"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Org {
  id: string;
  name: string;
  slug: string;
  memberCount: number;
  planName: string;
  subscriptionStatus: string;
  createdAt: string;
}

export default function AdminOrganizationsPage() {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  useEffect(() => {
    const params = new URLSearchParams({ search, page: String(page), limit: "20" });
    fetch(`/api/admin/organizations?${params}`)
      .then((res) => res.json())
      .then((data) => {
        setOrgs(data.organizations);
        setTotalPages(data.pagination.pages);
      });
  }, [search, page]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Organizations</h1>
        <input
          type="text"
          placeholder="Search..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Organization
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Members</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Plan</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {orgs.map((org) => (
              <tr key={org.id} className="bg-card">
                <td className="px-4 py-3">
                  <Link
                    href={`/admin/organizations/${org.id}`}
                    className="font-medium text-foreground hover:underline"
                  >
                    {org.name}
                  </Link>
                  <p className="text-xs text-muted-foreground">/{org.slug}</p>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{org.memberCount}</td>
                <td className="px-4 py-3">
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    {org.planName}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs capitalize text-muted-foreground">
                  {org.subscriptionStatus}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
