import { getServerSession } from "@/lib/session";
import { redirect } from "next/navigation";
import { AdminNav } from "@/components/admin-nav";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession();

  if (!session) {
    redirect("/sign-in/web");
  }

  if ((session.user as { role?: string }).role !== "admin") {
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="pointer-events-none fixed inset-0 opacity-80">
        <div className="absolute left-0 top-0 h-[28rem] w-[28rem] rounded-full bg-primary/8 blur-3xl" />
        <div className="absolute right-0 top-24 h-[24rem] w-[24rem] rounded-full bg-red-500/5 blur-3xl" />
      </div>
      <AdminNav user={session.user} />
      <main className="relative mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}
