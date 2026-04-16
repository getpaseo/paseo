import { auth } from "./auth";
import { headers } from "next/headers";

export async function getServerSession() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });
  return session;
}

export async function getSessionFromToken(token: string) {
  const session = await auth.api.getSession({
    headers: new Headers({ Authorization: `Bearer ${token}` }),
  });
  return session;
}

export async function requireSession() {
  const session = await getServerSession();
  if (!session) {
    throw new Error("Unauthorized");
  }
  return session;
}

export async function requireAdmin() {
  const session = await requireSession();
  if ((session.user as { role?: string }).role !== "admin") {
    throw new Error("Forbidden");
  }
  return session;
}
