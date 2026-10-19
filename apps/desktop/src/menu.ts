import { app, Menu } from "electron";
import type { MenuItemConstructorOptions } from "electron";

export interface MenuActions {
  navigate: (route: string) => void;
  agent: (section: string) => void;
  show: () => void;
  changeServer: () => void;
  stop: () => void;
  help: () => void;
  development: boolean;
}

export function installMenu(actions: MenuActions): void {
  const view: MenuItemConstructorOptions[] = [{ role: "reload" }, { role: "forceReload" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }];
  if (actions.development) view.push({ role: "toggleDevTools" });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Quokka Bot", submenu: [{ role: "about" }, { label: "Change server…", click: actions.changeServer }, { type: "separator" }, { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] },
    { label: "File", submenu: [{ label: "New task", accelerator: "CommandOrControl+N", click: () => actions.navigate("/?new=1") }, { role: "close" }] },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "View", submenu: view },
    { label: "Go", submenu: [
      { label: "Home", accelerator: "CommandOrControl+1", click: () => actions.navigate("/") },
      ...["computer", "tasks", "files", "domains", "logins", "audit", "settings"].map((section) => ({ label: section[0]?.toUpperCase() + section.slice(1), click: () => actions.agent(section) })),
    ] },
    { label: "Agent", submenu: [{ label: "Stop everything", accelerator: "CommandOrControl+Shift+.", click: actions.stop }] },
    { role: "windowMenu", submenu: [{ role: "minimize" }, { role: "zoom" }, { label: "Open Quokka Bot", click: actions.show }, { type: "separator" }, { role: "front" }] },
    { role: "help", submenu: [{ label: "Quokka Bot help", click: actions.help }] },
  ]));
  app.setAboutPanelOptions({ applicationName: "Quokka Bot", applicationVersion: app.getVersion() });
}
