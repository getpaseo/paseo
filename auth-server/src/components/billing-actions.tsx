"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

interface BillingActionsProps {
  planId?: string;
  hasStripeCustomer: boolean;
  buttonLabel?: string;
}

export function BillingActions({ planId, hasStripeCustomer, buttonLabel }: BillingActionsProps) {
  const [loading, setLoading] = useState(false);

  const handleCheckout = async () => {
    if (!planId) return;
    setLoading(true);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId }),
      });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
    } catch {
      // handle error
    } finally {
      setLoading(false);
    }
  };

  const handlePortal = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/billing/portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
    } catch {
      // handle error
    } finally {
      setLoading(false);
    }
  };

  if (hasStripeCustomer && !planId) {
    return (
      <Button variant="secondary" onClick={handlePortal} disabled={loading} className="mt-3">
        {loading ? "Loading..." : "Manage Subscription"}
      </Button>
    );
  }

  if (planId) {
    return (
      <Button fullWidth onClick={handleCheckout} disabled={loading}>
        {loading ? "Loading..." : buttonLabel || "Subscribe"}
      </Button>
    );
  }

  return null;
}
