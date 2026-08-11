export interface HubReporter {
  progress(message: string): void;
}

export const processHubReporter: HubReporter = {
  progress(message) {
    process.stderr.write(`${message}\n`);
  },
};

interface HubReportOptions {
  json?: boolean;
}

export function reportHubProgress(
  reporter: HubReporter,
  options: HubReportOptions,
  message: string,
): void {
  if (options.json === true) return;
  reporter.progress(message);
}
