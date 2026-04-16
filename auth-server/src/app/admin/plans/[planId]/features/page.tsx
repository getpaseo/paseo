"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

interface Feature {
  id: string;
  featureKey: string;
  value: string;
  description: string | null;
}

export default function PlanFeaturesPage() {
  const { planId } = useParams<{ planId: string }>();
  const [features, setFeatures] = useState<Feature[]>([]);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const fetchFeatures = async () => {
    const res = await fetch(`/api/admin/plans/${planId}/features`);
    const data = await res.json();
    setFeatures(data.features);
  };

  useEffect(() => {
    fetchFeatures();
  }, [planId]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetch(`/api/admin/plans/${planId}/features`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ featureKey: newKey, value: newValue, description: newDesc }),
    });
    setNewKey("");
    setNewValue("");
    setNewDesc("");
    await fetchFeatures();
  };

  const handleUpdate = async (featureKey: string) => {
    await fetch(`/api/admin/plans/${planId}/features`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ featureKey, value: editValue }),
    });
    setEditingId(null);
    await fetchFeatures();
  };

  const handleDelete = async (featureKey: string) => {
    if (!confirm(`Delete feature "${featureKey}"?`)) return;
    await fetch(`/api/admin/plans/${planId}/features?featureKey=${featureKey}`, {
      method: "DELETE",
    });
    await fetchFeatures();
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Plan Feature Flags</h1>
      <p className="text-sm text-muted-foreground">Plan ID: {planId}</p>

      {/* Add new feature */}
      <form onSubmit={handleAdd} className="flex gap-2">
        <input
          type="text"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder="Feature key"
          required
          className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <input
          type="text"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          placeholder="Value"
          required
          className="w-32 rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <input
          type="text"
          value={newDesc}
          onChange={(e) => setNewDesc(e.target.value)}
          placeholder="Description (optional)"
          className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <button
          type="submit"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Add
        </button>
      </form>

      {/* Features list */}
      <div className="space-y-2">
        {features.map((f) => (
          <div
            key={f.id}
            className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3"
          >
            <div className="flex-1">
              <p className="text-sm font-medium text-foreground">{f.featureKey}</p>
              {f.description && <p className="text-xs text-muted-foreground">{f.description}</p>}
            </div>

            {editingId === f.id ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  className="w-32 rounded border border-input bg-background px-2 py-1 text-sm"
                />
                <button
                  onClick={() => handleUpdate(f.featureKey)}
                  className="rounded px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10"
                >
                  Save
                </button>
                <button
                  onClick={() => setEditingId(null)}
                  className="rounded px-2 py-1 text-xs text-muted-foreground"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs">{f.value}</span>
                <button
                  onClick={() => {
                    setEditingId(f.id);
                    setEditValue(f.value);
                  }}
                  className="rounded px-2 py-1 text-xs text-primary hover:bg-primary/10"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(f.featureKey)}
                  className="rounded px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
