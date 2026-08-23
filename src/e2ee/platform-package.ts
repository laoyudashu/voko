import path from 'node:path';

const PLATFORM_PACKAGES: Record<string, string> = {
  'win32:x64': '@voko/e2ee-win32-x64',
  'linux:x64': '@voko/e2ee-linux-x64',
  'linux:arm64': '@voko/e2ee-linux-arm64',
  'darwin:x64': '@voko/e2ee-darwin-x64',
  'darwin:arm64': '@voko/e2ee-darwin-arm64',
};

type PackageResolver = (request: string) => string;

export function resolvePackagedE2eeRelease(input: {
  platform?: NodeJS.Platform;
  arch?: string;
  resolvePackageJson?: PackageResolver;
} = {}): { packageName: string; executable: string; manifestPath: string } | null {
  const platform = input.platform || process.platform;
  const arch = input.arch || process.arch;
  const packageName = PLATFORM_PACKAGES[`${platform}:${arch}`];
  if (!packageName) return null;

  let packageJsonPath: string;
  try {
    packageJsonPath = (input.resolvePackageJson || require.resolve)(`${packageName}/package.json`);
  } catch (error: any) {
    if (error?.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const packageRoot = pathApi.dirname(packageJsonPath);
  const executableName = platform === 'win32' ? 'voko-e2ee-endpoint.exe' : 'voko-e2ee-endpoint';
  const executable = pathApi.join(packageRoot, 'bin', executableName);
  return { packageName, executable, manifestPath: `${executable}.manifest.json` };
}

module.exports = { resolvePackagedE2eeRelease, PLATFORM_PACKAGES };
