import { readFileSync } from "node:fs";
import { writePrivateFileAtomicSync } from "@getpaseo/server/daemon-control";
import { z } from "zod";

const LaunchReceiptSchema = z.strictObject({
  home: z.string().min(1),
  pid: z.number().int().positive(),
  startedAt: z.iso.datetime(),
});

interface LaunchReceiptInput {
  filePath: string;
  home: string;
  instance: Pick<z.infer<typeof LaunchReceiptSchema>, "pid" | "startedAt">;
}

export function recordDesktopDaemonLaunch({ filePath, home, instance }: LaunchReceiptInput): void {
  writePrivateFileAtomicSync(
    filePath,
    JSON.stringify({ home, pid: instance.pid, startedAt: instance.startedAt }),
  );
}

export function hasDesktopDaemonLaunchReceipt({
  filePath,
  home,
  instance,
}: LaunchReceiptInput): boolean {
  let contents: string;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  let document: unknown;
  try {
    document = JSON.parse(contents);
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  const receipt = LaunchReceiptSchema.safeParse(document);
  return (
    receipt.success &&
    receipt.data.home === home &&
    receipt.data.pid === instance.pid &&
    receipt.data.startedAt === instance.startedAt
  );
}
