import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { localDaemonServerIdQueryOptions } from "./local-daemon-server-id-query";

describe("local daemon identity polling", () => {
  const client = new QueryClient();

  afterEach(() => client.clear());

  it("stops polling after an error and retries when the view reopens", async () => {
    let calls = 0;
    let status: { serverId: string; error: string | null } = {
      serverId: "",
      error: "Password required",
    };
    const options = localDaemonServerIdQueryOptions(async () => {
      calls++;
      return status;
    });
    const query = client.getQueryCache().build(client, options);

    await expect(client.fetchQuery(options)).rejects.toThrow("Password required");
    expect(options.refetchInterval(query)).toBe(false);
    expect(calls).toBe(1);

    status = { serverId: "srv_local", error: null };
    const observer = new QueryObserver(client, options);
    const settled = Promise.withResolvers<void>();
    const detach = observer.subscribe((result) => {
      if (result.fetchStatus === "idle") settled.resolve();
    });
    try {
      await settled.promise;
      expect(observer.getCurrentResult().data).toEqual({ serverId: "srv_local" });
      expect(options.refetchInterval(query)).toBe(false);
      expect(calls).toBe(2);
    } finally {
      detach();
    }
  });

  it.each(["focus", "reconnect"])("retries a failed query on %s", async (event) => {
    let calls = 0;
    let error: string | null = "Password required";
    const options = localDaemonServerIdQueryOptions(async () => {
      calls++;
      return { serverId: "srv_local", error };
    });
    const query = client.getQueryCache().build(client, options);
    const observer = new QueryObserver(client, options);
    let settled = Promise.withResolvers<void>();
    const detach = observer.subscribe((result) => {
      if (result.fetchStatus === "idle") settled.resolve();
    });
    try {
      await settled.promise;
      expect(observer.getCurrentResult().error?.message).toBe("Password required");
      expect(options.refetchInterval(query)).toBe(false);
      expect(calls).toBe(1);

      error = null;
      settled = Promise.withResolvers<void>();
      if (event === "focus") query.onFocus();
      else query.onOnline();
      await settled.promise;
      expect(observer.getCurrentResult().data).toEqual({ serverId: "srv_local" });
      expect(calls).toBe(2);
    } finally {
      detach();
    }
  });

  it("polls while identity is unavailable and reuses a resolved identity on remount", async () => {
    let calls = 0;
    let serverId = "";
    const options = localDaemonServerIdQueryOptions(async () => {
      calls++;
      return { serverId, error: null };
    });
    const query = client.getQueryCache().build(client, options);

    await expect(client.fetchQuery(options)).resolves.toEqual({ serverId: null });
    expect(options.refetchInterval(query)).toBe(1000);

    serverId = "  srv_local  ";
    await query.fetch();
    expect(query.state.data).toEqual({ serverId: "srv_local" });
    expect(options.refetchInterval(query)).toBe(false);

    const observer = new QueryObserver(client, options);
    const detach = observer.subscribe(() => {});
    try {
      await Promise.resolve();
      expect(observer.getCurrentResult().data).toEqual({ serverId: "srv_local" });
      expect(calls).toBe(2);
    } finally {
      detach();
    }
  });
});
