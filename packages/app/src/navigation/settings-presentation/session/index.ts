import { createSettingsPresentation } from "../model";

/** @package */
export const settingsPresentation = createSettingsPresentation();
export const beginSettingsSidebarVisit = settingsPresentation.beginSidebarVisit;
export const getSettingsSidebarReturn = () => settingsPresentation.store.getState().sidebarReturn;
