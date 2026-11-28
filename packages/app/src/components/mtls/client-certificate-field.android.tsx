import { requireNativeModule } from "expo-modules-core";
import { normalizeDirectConnectionHost } from "@/components/direct-connection-host";
import { ClientCertificateControls } from "./client-certificate-controls";
import type { ClientCertificateFieldProps } from "./client-certificate-field";
import type { ClientCertificateApi } from "./client-certificate-controls";

const certificates = requireNativeModule<ClientCertificateApi>("PaseoMtls");

export function ClientCertificateField({
  host,
  port,
  useTls,
  disabled,
}: ClientCertificateFieldProps) {
  const normalized = normalizeDirectConnectionHost(host);
  const effectivePort = Number(normalized.port ?? port);
  if (
    !useTls ||
    !normalized.host ||
    !Number.isInteger(effectivePort) ||
    effectivePort < 1 ||
    effectivePort > 65535
  ) {
    return null;
  }
  return (
    <ClientCertificateControls
      key={`${normalized.host}:${effectivePort}`}
      host={normalized.host}
      port={effectivePort}
      disabled={disabled}
      certificates={certificates}
    />
  );
}
