/** Key import is owned by Android; desktop uses the user's OpenSSH installation. */
export async function importPrivateKey(): Promise<ImportedPrivateKey | null> {
  throw new Error("SSH key import is only available on Android.");
}
import type { ImportedPrivateKey } from "./ssh-key-import-model";
