"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export default function NewOrganizationPage() {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleNameChange = (value: string) => {
    setName(value);
    setSlug(
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, ""),
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, slug }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create organization");
      }

      const data = await res.json();
      router.push(`/dashboard/organizations/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-md space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Create Organization</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Set up a new organization to collaborate with your team
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="name" className="block text-sm font-medium text-foreground">
            Organization Name
          </label>
          <input
            id="name"
            type="text"
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            required
            className="block w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30 transition-colors"
            placeholder="My Team"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="slug" className="block text-sm font-medium text-foreground">
            URL Slug
          </label>
          <div className="flex items-center rounded-lg border border-input bg-card overflow-hidden">
            <span className="px-3 text-sm text-muted-foreground bg-secondary/50 py-2 border-r border-input">
              hubcode.ai/
            </span>
            <input
              id="slug"
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              required
              pattern="[a-z0-9-]+"
              className="block w-full bg-transparent px-3 py-2 text-sm text-foreground focus:outline-none"
              placeholder="my-team"
            />
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        <Button type="submit" fullWidth size="lg" disabled={loading || !name || !slug}>
          {loading ? "Creating..." : "Create Organization"}
        </Button>
      </form>
    </div>
  );
}
