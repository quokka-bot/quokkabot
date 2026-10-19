import { app, Menu, nativeImage, Tray } from "electron";
import { join } from "node:path";

export class DesktopTray {
  readonly tray: Tray;
  private connected = false;
  private waiting: number | null = null;
  constructor(directory: string, private readonly show: () => void, private readonly stop: () => void, private readonly downloads: () => void) {
    const icon = nativeImage.createFromPath(join(directory, "../build/trayTemplate.png"));
    if (icon.isEmpty()) throw new Error("The Quokka Bot tray icon is missing.");
    icon.setTemplateImage(true);
    this.tray = new Tray(icon);
    this.tray.on("click", this.show);
    this.rebuild();
  }
  status(connected: boolean, waiting: number | null): void { this.connected = connected; this.waiting = waiting; this.rebuild(); }
  private rebuild(): void {
    const status = this.connected ? `${this.waiting} waiting` : "Not connected";
    this.tray.setToolTip(`Quokka Bot – ${status}`);
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: status, enabled: false }, { label: "Open Quokka Bot", click: this.show },
      { label: "Show downloads", click: this.downloads }, { type: "separator" },
      { label: "Stop everything", accelerator: "CommandOrControl+Shift+.", click: this.stop },
      { type: "separator" }, { label: "Quit Quokka Bot", click: () => app.quit() },
    ]));
  }
  dispose(): void { this.tray.destroy(); }
}
