"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

interface UserDetail {
  user: {
    id: string;
    name: string;
    email: string;
    image: string | null;
    role: string;
    banned: boolean;
    createdAt: string;
  };
  organizations: Array<{
    id: string;
    name: string;
    slug: string;
    role: string;
  }>;
}

export default function AdminUserDetailPage() {
  const { userId } = useParams<{ userId: string }>();
  const [data, setData] = useState<UserDetail | null>(null);

  useEffect(() => {
    fetch(`/api/admin/users/${userId}`)
      .then((res) => res.json())
      .then(setData);
  }, [userId]);

  if (!data) return <p className="text-sm text-muted-foreground">Loading...</p>;

  const { user, organizations } = data;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">User Details</h1>

      <div className="rounded-lg border border-border bg-card p-6">
        <div className="flex items-center gap-4">
          {user.image && (
            <img src={user.image} alt={user.name} className="h-16 w-16 rounded-full" />
          )}
          <div>
            <p className="text-lg font-semibold text-foreground">{user.name}</p>
            <p className="text-sm text-muted-foreground">{user.email}</p>
            <div className="mt-1 flex items-center gap-2">
              <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium capitalize">
                {user.role}
              </span>
              {user.banned && (
                <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                  Banned
                </span>
              )}
            </div>
          </div>
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          Joined: {new Date(user.createdAt).toLocaleDateString()}
        </p>
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Organizations</h2>
        {organizations.length > 0 ? (
          <div className="space-y-2">
            {organizations.map((org) => (
              <Link
                key={org.id}
                href={`/admin/organizations/${org.id}`}
                className="flex items-center justify-between rounded-lg border border-border bg-card p-3 hover:bg-accent"
              >
                <div>
                  <p className="font-medium text-foreground">{org.name}</p>
                  <p className="text-xs text-muted-foreground">/{org.slug}</p>
                </div>
                <span className="text-xs capitalize text-muted-foreground">{org.role}</span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No organizations</p>
        )}
      </div>
    </div>
  );
}
