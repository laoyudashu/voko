const http = require('http');
const {
  cleanupOrphanedWorkers,
  isInstanceAlive,
  readInstanceMetadata,
  removeInstanceLock,
  terminateInstance,
  waitForProcessExit,
} = require('./process-lifecycle');

export interface StopVokoResult {
  wasRunning: boolean;
  stopped: boolean;
  gracefulRequested: boolean;
  port: number | null;
  remainingPids: number[];
}

async function requestJson(options: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const request = http.request(options, (response: any) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => {
        if (options.method === 'POST') {
          response.statusCode === 200 ? resolve({}) : reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.end();
  });
}

export async function stopVoko(dbPath: string, onGraceful?: (port: number) => void): Promise<StopVokoResult> {
  const instance = readInstanceMetadata(dbPath);
  if (!instance || !isInstanceAlive(instance)) {
    const orphanResult = cleanupOrphanedWorkers(dbPath);
    return {
      wasRunning: false,
      stopped: orphanResult.skipped.length === 0,
      gracefulRequested: false,
      port: null,
      remainingPids: orphanResult.skipped.filter((pid: number) => pid > 0),
    };
  }

  let gracefulRequested = false;
  if (instance.port) {
    try {
      const health = await requestJson({
        hostname: '127.0.0.1', port: instance.port, path: '/health', method: 'GET', timeout: 2000,
      });
      if (health?.instanceId === instance.instanceId) {
        await requestJson({
          hostname: '127.0.0.1', port: instance.port, path: '/api/quit', method: 'POST', timeout: 3000,
          headers: { 'X-VOKO-Instance-ID': instance.instanceId, 'X-VOKO-Token': instance.mcpToken },
        });
        gracefulRequested = true;
        onGraceful?.(instance.port);
      }
    } catch {}
  }

  let stopped = gracefulRequested ? await waitForProcessExit(instance.pid, 7000) : false;
  if (!stopped) {
    stopped = await terminateInstance(instance);
    if (!stopped) stopped = await waitForProcessExit(instance.pid, 2000);
  }
  const orphanResult = cleanupOrphanedWorkers(dbPath);
  if (stopped) removeInstanceLock(dbPath, instance.instanceId);
  const remainingPids = [!stopped ? instance.pid : null, ...orphanResult.skipped]
    .filter((pid): pid is number => Number.isInteger(pid) && Number(pid) > 0);
  return {
    wasRunning: true,
    stopped: stopped && remainingPids.length === 0,
    gracefulRequested,
    port: instance.port || null,
    remainingPids: [...new Set(remainingPids)],
  };
}

module.exports = { stopVoko };
