import { type Page } from "@playwright/test";

export function renameModalInput(page: Page, testIdPrefix: string) {
  return page.getByTestId(`${testIdPrefix}-input`);
}

export function renameModalSubmit(page: Page, testIdPrefix: string) {
  return page.getByTestId(`${testIdPrefix}-submit`);
}

export function renameModalError(page: Page, testIdPrefix: string) {
  return page.getByTestId(`${testIdPrefix}-error`);
}
