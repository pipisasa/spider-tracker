/**
 * The oldest spider CLI the API still supports. Sent as `X-Spider-Min-Cli` on /v1 and /mcp
 * responses; older CLIs warn and suggest `spider update`. Raise it only after releasing a CLI
 * at least this new.
 */
export const MIN_CLI_VERSION = "0.1.3";
export const MIN_CLI_HEADER = "X-Spider-Min-Cli";
