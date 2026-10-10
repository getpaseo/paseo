import { createRemoteSshHostConnection } from "@/types/host-connection";

export interface ImportedPrivateKey {
  name: string;
  text: string;
}

export interface SshImportTarget {
  host: string;
  sshPort?: number;
  daemonPort?: number;
}
export interface SshKeyImportBridge {
  inspect(target: SshImportTarget, privateKey: string, passphrase: string): Promise<string>;
  stage(
    id: string,
    target: SshImportTarget,
    privateKey: string,
    passphrase: string,
    fingerprint: string,
  ): Promise<void>;
  commit(id: string): Promise<void>;
  discard(id: string): Promise<void>;
}

export interface ApprovedSshKey {
  target: SshImportTarget;
  privateKey: string;
  passphrase: string;
  fingerprint: string;
}

interface SshImportOperation<T> {
  bridge: SshKeyImportBridge;
  approved: ApprovedSshKey;
  saveHost: (beforeSave: () => Promise<void>) => Promise<T>;
}

const importTails = new Map<string, Promise<void>>();

/**
 * Serialize each destination's complete import transaction, including discard. A dismissed
 * form's pending probe must not erase or overwrite a new form's staged credentials.
 */
export async function saveImportedSshHost<T>({
  bridge,
  approved,
  saveHost,
}: SshImportOperation<T>): Promise<T> {
  const id = createRemoteSshHostConnection(approved.target).id;
  const previous = importTails.get(id);
  let release = () => {};
  const completed = new Promise<void>((resolve) => {
    release = resolve;
  });
  importTails.set(id, completed);
  await previous;
  try {
    await bridge.stage(
      id,
      approved.target,
      approved.privateKey,
      approved.passphrase,
      approved.fingerprint,
    );
    try {
      return await saveHost(() => bridge.commit(id));
    } finally {
      await bridge.discard(id);
    }
  } finally {
    release();
    if (importTails.get(id) === completed) importTails.delete(id);
  }
}
