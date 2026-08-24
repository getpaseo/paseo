const DENIED_CAMERA_PERMISSION = {
  canAskAgain: false,
  expires: "never",
  granted: false,
  status: "denied",
} as const;

async function requestCameraPermission() {
  return DENIED_CAMERA_PERMISSION;
}

export function useCameraPermissions() {
  return [DENIED_CAMERA_PERMISSION, requestCameraPermission] as const;
}

export function CameraView(): null {
  return null;
}
