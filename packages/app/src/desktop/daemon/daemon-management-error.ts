export class DaemonConnectionRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonConnectionRegistrationError";
  }
}
