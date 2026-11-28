export interface DeviceFileSelection {
  name: string;
  size: number;
  read(): Promise<Uint8Array>;
}
