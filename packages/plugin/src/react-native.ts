import type { ComponentType, ReactNode } from "react";
import type { PluginIconProps } from "./contracts.js";

export interface ModalProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  children: ReactNode;
}

export type ToastVariant = "default" | "info" | "success" | "warning" | "error";

export interface ToastOptions {
  variant?: ToastVariant;
  durationMs?: number;
}

export interface ToastApi {
  show(message: string, options?: ToastOptions): void;
  error(message: string): void;
}

export declare const Icon: ComponentType<PluginIconProps>;
export declare const Modal: ComponentType<ModalProps>;
export declare function useToast(): ToastApi;

export type { PluginIconProps } from "./contracts.js";
