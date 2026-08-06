export {};

/**
 * Validate that a local HTTP endpoint belongs to the currently recorded Lite
 * instance.  Port discovery alone is not sufficient: an old Desktop process
 * or another Lite instance may still be listening on that port.
 */

const PROBE_TIMEOUT_MS = 2500;

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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs || PROBE_TIMEOUT_MS));
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
      return failure('RUNTIME_UNAVAILABLE', '当前 Lite 运行实例不可用');
    }
    if (!body.instanceId || !body.pid || !body.port || !body.version || body.edition !== 'lite'
      || String(body.instanceId) !== expectedInstanceId
      || Number(body.pid) !== expectedPid
      || Number(body.port) !== port) {
      return failure('RUNTIME_MISMATCH', '当前 Lite 运行实例身份不匹配');
    }
    if (body.status !== 'ok' && body.status !== 'draining') {
      return failure('RUNTIME_UNAVAILABLE', '当前 Lite 运行实例尚未就绪');
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
  } catch (_) {
    return failure('RUNTIME_UNAVAILABLE', '无法连接当前 Lite 运行实例');
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { probeRuntimeIdentity, PROBE_TIMEOUT_MS };
