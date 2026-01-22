import * as QRCode from "qrcode";
import type { QRCodeToStringOptionsTerminal, QRCodeToStringOptionsOther } from "qrcode";
import type { Logger } from "pino";

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return undefined;
}

function shouldPrintPairingQr(): boolean {
  const env = parseBooleanEnv(process.env.PASEO_PAIRING_QR);
  if (env !== undefined) return env;
  return Boolean(process.stdout.isTTY);
}

async function renderQr(url: string): Promise<string> {
  const terminalOptions: QRCodeToStringOptionsTerminal = {
    type: "terminal",
    small: true,
  };

  const utf8Options: QRCodeToStringOptionsOther = {
    type: "utf8",
  };

  try {
    return await QRCode.toString(url, terminalOptions);
  } catch {
    return await QRCode.toString(url, utf8Options);
  }
}

export async function printPairingQrIfEnabled(args: {
  url: string;
  logger?: Logger;
}): Promise<void> {
  if (!shouldPrintPairingQr()) return;

  const qr = await renderQr(args.url);
  const out = `\nScan to pair:\n${qr}\n${args.url}\n`;

  try {
    process.stdout.write(out);
  } catch (error) {
    args.logger?.debug({ error }, "Failed to print pairing QR");
  }
}
