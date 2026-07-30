import * as QRCode from "qrcode";
import type { QRCodeToStringOptionsOther } from "qrcode";

const BLACK_ON_WHITE = "\u001b[47m\u001b[30m";
const RESET_COLORS = "\u001b[0m";

export async function renderPairingQr(url: string): Promise<string> {
  const utf8Options: QRCodeToStringOptionsOther = {
    type: "utf8",
    margin: 4,
  };

  const qr = await QRCode.toString(url, utf8Options);
  return qr
    .split("\n")
    .map((line) => `${BLACK_ON_WHITE}${line}${RESET_COLORS}`)
    .join("\n");
}
