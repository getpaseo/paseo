import { redirect } from "next/navigation";

export default async function BillingPage() {
  redirect("/dashboard/billing");
}
