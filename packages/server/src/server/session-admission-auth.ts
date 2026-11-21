import type { WSHelloMessage } from "@getpaseo/protocol/messages";
import { type DaemonAuthConfig, OWNER_PRINCIPAL, resolveDaemonSecret } from "./auth.js";
import { matchesLocalCredential } from "./local-credential.js";
import type { SessionAdmission } from "./websocket-server.js";

export type AdmissionFailure = "password_required" | "incorrect_password";

type AdmissionResolution = { admission: SessionAdmission } | { rejection: AdmissionFailure };

export async function resolveSessionAdmission(input: {
  credential: WSHelloMessage["auth"];
  auth: Pick<DaemonAuthConfig, "password" | "credentials"> | undefined;
  localCredential: string | null;
}): Promise<AdmissionResolution> {
  const { credential, auth, localCredential } = input;
  if (!auth?.password) {
    return { admission: OWNER_PRINCIPAL };
  }
  if (!credential) {
    return { rejection: "password_required" };
  }
  if (credential.kind === "localCredential") {
    if (localCredential && matchesLocalCredential(localCredential, credential.token)) {
      return { admission: OWNER_PRINCIPAL };
    }
    return { rejection: "incorrect_password" };
  }
  const principal = await resolveDaemonSecret(auth, credential.password);
  return principal ? { admission: principal } : { rejection: "incorrect_password" };
}
