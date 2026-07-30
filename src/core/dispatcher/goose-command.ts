/**
 * Resolve the Goose executable without assuming a developer-machine path.
 *
 * An explicit VOKO_GOOSE_BIN may point to a platform-specific executable.
 * Otherwise child_process resolves the native executable from PATH.
 * Windows uses `goose.exe` explicitly so the generic CLI runner never routes
 * untrusted Goose input through `cmd.exe`.
 */
function resolveGooseCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = env.VOKO_GOOSE_BIN?.trim();
  return configured || (platform === 'win32' ? 'goose.exe' : 'goose');
}

module.exports = { resolveGooseCommand };
