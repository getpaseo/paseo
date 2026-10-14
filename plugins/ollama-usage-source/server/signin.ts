import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** `ollama signin` registers this key with ollama.com; the local server signs cloud calls with it. */
export function signinKeyPath(home = homedir()): string {
  return path.join(home, ".ollama", "id_ed25519");
}

export interface SigninKey {
  publicKey: string;
  privateKey: KeyObject;
}

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const OPENSSH_MAGIC = "openssh-key-v1\0";

function reader(buffer: Buffer) {
  let offset = 0;
  return {
    skip(bytes: number) {
      offset += bytes;
    },
    string(): Buffer {
      const length = buffer.readUInt32BE(offset);
      offset += 4;
      const value = buffer.subarray(offset, offset + length);
      offset += length;
      return value;
    },
  };
}

function ed25519SeedFromOpenSsh(text: string): Buffer {
  const body = Buffer.from(
    text.replace(/-----(BEGIN|END) OPENSSH PRIVATE KEY-----/g, "").replace(/\s+/g, ""),
    "base64",
  );
  if (body.subarray(0, OPENSSH_MAGIC.length).toString("latin1") !== OPENSSH_MAGIC)
    throw new Error("Not an OpenSSH private key");
  const outer = reader(body);
  outer.skip(OPENSSH_MAGIC.length);
  if (outer.string().toString() !== "none")
    throw new Error("Encrypted Ollama keys are not supported");
  outer.string();
  outer.string();
  outer.skip(4);
  outer.string();
  const inner = reader(outer.string());
  inner.skip(8);
  if (inner.string().toString() !== "ssh-ed25519") throw new Error("Ollama key is not ed25519");
  inner.string();
  return inner.string().subarray(0, 32);
}

export async function readSigninKey(keyPath: string): Promise<SigninKey | undefined> {
  let privateText: string;
  let publicText: string;
  try {
    [privateText, publicText] = await Promise.all([
      readFile(keyPath, "utf8"),
      readFile(`${keyPath}.pub`, "utf8"),
    ]);
  } catch {
    return undefined;
  }
  const publicKey = publicText.trim().split(/\s+/)[1];
  if (!publicKey) return undefined;
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, ed25519SeedFromOpenSsh(privateText)]),
    format: "der",
    type: "pkcs8",
  });
  return { publicKey, privateKey };
}

/** Ollama's request signature: `<ssh public key>:<base64 ed25519 signature of "METHOD,path?ts=…">`. */
export function signRequest(
  key: SigninKey,
  method: string,
  pathname: string,
  now = Date.now(),
): { query: string; authorization: string } {
  const ts = Math.floor(now / 1000).toString();
  const challenge = `${method},${pathname}?ts=${ts}`;
  const signature = sign(null, Buffer.from(challenge), key.privateKey).toString("base64");
  return { query: `ts=${ts}`, authorization: `${key.publicKey}:${signature}` };
}
