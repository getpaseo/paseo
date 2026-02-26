// Core auth functionality
export { generateTotpSecret, verifyTotp, generateQrCodeDataUrl } from "./totp.js"
export {
  initJwt,
  issueToken,
  verifyToken,
  shouldRefreshToken,
  createJwtValidator,
  loadOrCreateJwtSecret,
} from "./jwt.js"
export {
  initAuthDb,
  createUser,
  getUserByUsername,
  getUserById,
  listUsers,
  deleteUser,
  markTotpCodeUsed,
  getUserCount,
} from "./store.js"
export {
  authMiddleware,
  adminMiddleware,
  authenticateWsToken,
} from "./middleware.js"
export type { User, TokenPayload, AuthConfig } from "./types.js"
