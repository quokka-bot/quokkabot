// Size limits shared by the control plane, the browser service and the tools sandbox.
//
// Claude Code writes large MCP results to a file under its private home and hands the model a path instead. In
// Quokka Bot that home is in the CLI sandbox, where the model has no file tools, so every tool result must stay
// below that threshold. Long content is paginated with a continuation cursor instead.
export const LIMITS = {
  toolResultChars: 20_000,
  snapshotPageChars: 16_000,
  fileReadChars: 16_000,
  fileReadDefaultLines: 400,
  execOutputChars: 12_000,
  filesListEntries: 200,
  typeTextChars: 2_000,
  fileWriteChars: 200_000,
  execCommandChars: 8_000,
  execTimeoutSecondsMax: 600,
  waitTimeoutSecondsMax: 30,
  screenshotMaxBytes: 1_500_000,
  downloadMaxBytes: 200 * 1024 * 1024,
  domainsPerRequest: 20,
  ownerQuestionChars: 2_000,
  attachFilesMax: 50,
} as const;
