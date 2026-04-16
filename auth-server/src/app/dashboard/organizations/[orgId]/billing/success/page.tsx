"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function BillingSuccessPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard/billing/success");
  }, [router]);

  return null;
}
