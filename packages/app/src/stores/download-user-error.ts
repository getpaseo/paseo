// Marks a download failure whose message is already localized and safe to show to the user.
// Any other error is logged and shown as the generic `downloads.failed` copy.
export class DownloadUserError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DownloadUserError";
  }
}
