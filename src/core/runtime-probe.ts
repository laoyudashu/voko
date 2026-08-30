export {};

/**
 * Validate that a local HTTP endpoint belongs to the currently recorded Lite
 * instance.  Port discovery alone is not sufficient: an old Desktop process
 * or another Lite instance may still be listening on that port.
 */

const PROBE_TIMEOUT_MS = 2500;
const STARTUP_ATTEMPTS = 3;
const STARTUP_RETRY_DELAY_MS = 100;

function failure(code: string, message: string, details: any = undefined): any {
  const result: any = { ok: false, code, message };
  if (details !== undefined) result.details = details;
  return result;
}

async function probeRuntimeIdentity(options: any = {}): Promise<any> {
  const instance = options.instance || {};
  const port = Number(options.port || instance.port || 0);
  const expectedInstanceId = String(instance.instanceId || '').trim();
  const expectedPid = Number(instance.pid || 0);
  if (!port || !expectedInstanceId || !expectedPid) {
    return failure('RUNTIME_REQUIRED', '请先运行 voko start --no-open --no-interactive');
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return failure('RUNTIME_UNAVAILABLE', '无法检查本机 Lite 运行实例');
  }

  const attempts = Math.max(1, Number(options.startupAttempts || STARTUP_ATTEMPTS));
  const totalTimeoutMs = Math.max(1, Number(options.timeoutMs || PROBE_TIMEOUT_MS));
  const attemptTimeoutMs = Math.max(1, Math.floor(totalTimeoutMs / attempts));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? STARTUP_RETRY_DELAY_MS));
  let lastReason = '无法连接当前 Lite 运行实例';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
    try {
      const headers: Record<string, string> = {};
      if (instance.mcpToken) headers['X-VOKO-Token'] = String(instance.mcpToken);
      const response = await fetchImpl(`http://127.0.0.1:${port}/health`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null) as any;
      if (!response.ok || !body) {
        throw { startupReason: '当前 Lite 运行实例不可用' };
      }
      if (!body.instanceId || !body.pid || !body.port || !body.version || body.edition !== 'lite'
        || String(body.instanceId) !== expectedInstanceId
        || Number(body.pid) !== expectedPid
        || Number(body.port) !== port) {
        return failure('RUNTIME_MISMATCH', '当前 Lite 运行实例身份不匹配', {
          expected: { instanceId: expectedInstanceId, pid: expectedPid, port },
          observed: { instanceId: body?.instanceId || null, pid: body?.pid || null, port: body?.port || null },
        });
      }
      if (body.status !== 'ok' && body.status !== 'draining') {
        throw { startupReason: '当前 Lite 运行实例尚未就绪' };
      }
      return {
        ok: true,
        runtime: {
          instanceId: expectedInstanceId,
          pid: expectedPid,
          port,
          version: typeof body.version === 'string' ? body.version : null,
          status: body.status,
        },
      };
    } catch (error: any) {
      lastReason = error?.startupReason || '无法连接当前 Lite 运行实例';
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts && retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  return failure('RUNTIME_STARTING', lastReason, { attempts });
}

module.exports = { probeRuntimeIdentity, PROBE_TIMEOUT_MS, STARTUP_ATTEMPTS, STARTUP_RETRY_DELAY_MS };
