export interface DownloadProgress {
  percent: number;
  bytesWritten: number;
  totalBytes: number;
  speed: number;
  eta: number;
}

interface DownloadProgressSample {
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
  now: number;
}

export function computeDownloadProgress(sample: DownloadProgressSample): DownloadProgress | null {
  const { receivedBytes, totalBytes, startedAt, now } = sample;
  if (totalBytes <= 0) {
    return null;
  }
  const elapsedSeconds = (now - startedAt) / 1000;
  const speed = elapsedSeconds > 0 ? receivedBytes / elapsedSeconds : 0;
  const remainingBytes = totalBytes - receivedBytes;
  const eta = speed > 0 ? remainingBytes / speed : 0;
  return {
    percent: receivedBytes / totalBytes,
    bytesWritten: receivedBytes,
    totalBytes,
    speed,
    eta,
  };
}
