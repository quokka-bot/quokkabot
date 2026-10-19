export const IPC = {
  startSignIn: "quokkabot:start-sign-in", startFreshCheck: "quokkabot:start-fresh-check",
  waitForFlow: "quokkabot:wait-for-flow", cancelFlow: "quokkabot:cancel-flow",
  download: "quokkabot:download", showDownloads: "quokkabot:show-downloads",
  getSettings: "quokkabot:get-settings", setSettings: "quokkabot:set-settings",
  getUpdateStatus: "quokkabot:get-update-status", installUpdate: "quokkabot:install-update",
  changeServer: "quokkabot:change-server", navigate: "quokkabot:navigate",
  connect: "quokkabot:connect", connectVersion: "quokkabot:connect-version",
} as const;
