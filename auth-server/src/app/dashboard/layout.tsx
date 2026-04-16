import { getServerSession } from "@/lib/session";
import { redirect } from "next/navigation";
import { DashboardNav } from "@/components/dashboard-nav";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession();

  if (!session) {
    redirect("/sign-in/web");
  }

  return (
    <div className="min-h-screen bg-background">
      <DashboardNav user={session.user} />
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
