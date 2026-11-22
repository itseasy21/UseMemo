import { isTauri } from "@/lib/tauri";

/**
 * Reveal the detached recording HUD.
 *
 * Inside Tauri the `hud` window already exists (transparent, always-on-top,
 * hidden at launch). In a browser preview the same route opens in a new tab.
 */
export async function openHud(): Promise<void> {
  if (isTauri()) {
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const hud = await WebviewWindow.getByLabel("hud");
      if (hud) {
        await hud.show();
        await hud.setFocus();
        return;
      }
    } catch (error) {
      console.warn("[memo] could not show the HUD window", error);
    }
  }
  window.open("/hud/", "_blank", "noopener,noreferrer");
}
