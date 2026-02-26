import { TOTP, Secret } from "otpauth"
import QRCode from "qrcode"

const ISSUER = "Junction"
const PERIOD = 30
const DIGITS = 6
const ALGORITHM = "SHA256"

export function generateTotpSecret(username: string): {
  secret: string
  uri: string
} {
  const totp = new TOTP({
    issuer: ISSUER,
    label: username,
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD,
    secret: new Secret(),
  })

  return {
    secret: totp.secret.base32,
    uri: totp.toString(),
  }
}

export function verifyTotp(secret: string, token: string): boolean {
  const totp = new TOTP({
    issuer: ISSUER,
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD,
    secret: Secret.fromBase32(secret),
  })

  const delta = totp.validate({ token, window: 1 })
  return delta !== null
}

export async function generateQrCodeDataUrl(uri: string): Promise<string> {
  return QRCode.toDataURL(uri)
}
