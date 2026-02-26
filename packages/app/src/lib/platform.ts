export function isDesktopApp(): boolean {
  return false
}

export function isMobile(): boolean {
  if (typeof navigator === "undefined") return false
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent,
  )
}

export function getPlatform(): "web" | "mobile" {
  return isMobile() ? "mobile" : "web"
}
