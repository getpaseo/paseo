import { compare } from "bcryptjs";
import type { WSHelloMessage } from "@getpaseo/protocol/messages";
import { OWNER_PERMISSIONS } from "./authorization/index.js";
import { matchesLocalCredential } from "./local-credential.js";
import type { SessionAdmission } from "./websocket-server.js";

import type { DeviceCredentials } from "./device-credentials.js";

export type AdmissionFailure = "password_required" | "incorrect_password";

type AdmissionResolution = { admission: SessionAdmission } | { rejection: AdmissionFailure };

export async function resolveSessionAdmission(input: {
  credential: WSHelloMessage["auth"];
  passwordHash: string | undefined;
  localCredential: string | null;
  deviceCredentials?: DeviceCredentials;
}): Promise<AdmissionResolution> {
  const { credential, passwordHash, localCredential } = input;
  if (!passwordHash) {
    return { admission: { principalId: "owner", permissions: OWNER_PERMISSIONS } };
  }
  if (!credential) {
    return { rejection: "password_required" };
  }
  if (credential.kind === "localCredential") {
    if (localCredential && matchesLocalCredential(localCredential, credential.token)) {
      return { admission: { principalId: "owner", permissions: OWNER_PERMISSIONS } };
    }
    return { rejection: "incorrect_password" };
  }
  if (credential.kind === "deviceCredential") {
    return input.deviceCredentials?.accepts(credential.id, credential.secret)
      ? {
          admission: {
            principalId: "owner",
            permissions: OWNER_PERMISSIONS,
            credentialId: credential.id,
          },
        }
      : { rejection: "incorrect_password" };
  }
  if (credential.kind === "pairingToken") {
    return input.deviceCredentials?.consumeToken(credential.token)
      ? { admission: { principalId: "owner", permissions: OWNER_PERMISSIONS } }
      : { rejection: "incorrect_password" };
  }
  return (await compare(credential.password, passwordHash))
    ? { admission: { principalId: "owner", permissions: OWNER_PERMISSIONS } }
    : { rejection: "incorrect_password" };
}
