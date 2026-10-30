import { app, Menu, MenuItemConstructorOptions, shell } from "electron";
import { listServers, ServerEntry } from "./serverStore";

export interface AppMenuCallbacks {
  onSwitchServer: (id: string) => void;
  onManageBackends: () => void;
  onCheckForUpdates: () => void;
  readyUpdateVersion: () => string | null;
  onInstallUpdate: () => void;
  onAbout: () => void;
  onQuit: () => void;
}

// Without a real menu, Electron falls back to a generic "Electron" template
// with no way into server management short of the tray. This also gives the
// server window a Cmd/Ctrl+K accelerator for it, since that window's content
// is the self-hosted web app and isn't ours to add a button to.
export function buildAppMenu(callbacks: AppMenuCallbacks): void {
  const isMac = process.platform === "darwin";
  const servers: ServerEntry[] = listServers();

  const updateItems: MenuItemConstructorOptions[] = callbacks.readyUpdateVersion()
    ? [{ label: "Restart to Install Update", click: callbacks.onInstallUpdate }]
    : [];

  const serverItems: MenuItemConstructorOptions[] = servers.map((s) => ({
    label: s.name,
    click: () => callbacks.onSwitchServer(s.id),
  }));

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              // Not role: "about" — that panel can't show the server's version.
              { label: "About Hasht", click: callbacks.onAbout },
              {
                label: "Check for Updates…",
                click: callbacks.onCheckForUpdates,
              },
              ...updateItems,
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { label: "Quit", accelerator: "Cmd+Q", click: callbacks.onQuit },
            ],
          },
        ]
      : []),
    {
      label: "Servers",
      submenu: [
        {
          label: "Manage Servers…",
          accelerator: "CmdOrCtrl+K",
          click: callbacks.onManageBackends,
        },
        ...(serverItems.length
          ? ([
              { type: "separator" as const },
              ...serverItems,
            ] as MenuItemConstructorOptions[])
          : []),
        ...(isMac
          ? []
          : ([
              { type: "separator" as const },
              { label: "Quit", accelerator: "Ctrl+Q", click: callbacks.onQuit },
            ] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        ...(isMac
          ? [
              { role: "zoom" as const },
              { type: "separator" as const },
              { role: "front" as const },
            ]
          : [{ role: "close" as const }]),
      ],
    },
    {
      role: "help",
      submenu: [
        // No app-name submenu on Windows/Linux, so About lives here instead.
        ...(isMac
          ? []
          : [
              { label: "About Hasht", click: callbacks.onAbout },
              { type: "separator" as const },
              {
                label: "Check for Updates…",
                click: callbacks.onCheckForUpdates,
              },
              ...updateItems,
              { type: "separator" as const },
            ]),
        {
          label: "Learn More",
          click: () =>
            shell.openExternal("https://github.com/Hasht-net/hasht-desktop"),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
