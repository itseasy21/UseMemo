/**
 * Client-safe platform detection helpers for keyboard hints, window chrome
 * safe-areas, and platform-appropriate copy across macOS, Windows, Linux, iOS,
 * and Android.
 */

import { isTauri } from "@/lib/tauri";

export type HostOs = "macos" | "windows" | "linux" | "ios" | "android" | "web";

export function detectHostOs(): HostOs {
  if (typeof navigator === "undefined") return "web";
  const ua = navigator.userAgent.toLowerCase();
  const platform = (navigator.platform ?? "").toLowerCase();

  if (/android/.test(ua)) return "android";
  if (/iphone|ipad|ipod/.test(ua) || (platform === "macintel" && navigator.maxTouchPoints > 1)) {
    return "ios";
  }
  if (platform.startsWith("mac") || ua.includes("mac os x")) return "macos";
  if (platform.startsWith("win") || ua.includes("windows")) return "windows";
  if (platform.includes("linux") || ua.includes("linux")) return "linux";
  return "web";
}

/**
 * True only inside a desktop macOS Tauri window where `titleBarStyle: "Overlay"`
 * places native traffic-light window controls in the top-left 76px region.
 */
export function hasMacOverlayTrafficLights(): boolean {
  return isTauri() && detectHostOs() === "macos";
}

export function isApplePlatform(): boolean {
  const os = detectHostOs();
  return os === "macos" || os === "ios";
}

export function modKeyPrefix(): string {
  return isApplePlatform() ? "⌘" : "Ctrl+";
}

export function shiftModKeyPrefix(): string {
  return isApplePlatform() ? "⇧⌘" : "Ctrl+Shift+";
}

export function localDeviceNoun(): string {
  switch (detectHostOs()) {
    case "macos":
      return "this Mac";
    case "windows":
      return "this PC";
    case "ios":
      return "this iPhone";
    case "android":
      return "this device";
    default:
      return "this device";
  }
}
