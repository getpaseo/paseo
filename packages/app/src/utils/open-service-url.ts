import { openWebUrl, type WebUrlClick } from "@/utils/open-web-url";

export interface OpenServiceUrlOptions {
  event?: WebUrlClick;
}

export async function openServiceUrl(url: string, options?: OpenServiceUrlOptions): Promise<void> {
  await openWebUrl(url, options?.event);
}
