/**
 * runtime-port.js — 读取 DB runtime 记录的实际监听端口
 *
 * Lite 启动时把实际监听端口（端口被占时可能与 args.port 不同）写入 config 表的 runtime 行。
 * 此模块供无法直接拿到端口的地方（voko stop / voko mcp 等）读取。
 *
 * 与 lite-launcher._checkRuntimeRunning 的区别：本模块只读端口，不做 PID 存活检查
 * （调用方决定是否信任该端口；stop/mcp 会实际连接验证）。
 */

interface RuntimePortSnapshot {
  instanceId?: string;
  pid?: number;
  port?: string | number;
}

function validPort(value: unknown): number | null {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function readRuntimeSnapshot(dbPath: string): RuntimePortSnapshot | null {
  if (!dbPath) return null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT data FROM config WHERE type = 'runtime'").get() as { data: string } | undefined;
      if (!row) return null;
      const data: unknown = JSON.parse(row.data);
      return data && typeof data === 'object' && !Array.isArray(data)
        ? data as RuntimePortSnapshot
        : null;
    } finally {
      try { db.close(); } catch {}
    }
  } catch {
    return null;
  }
}

/**
 * 兼容读取 runtime 快照。仅供状态展示/旧调用，不证明实例仍存活。
 */
function getRuntimePort(dbPath: string): number | null {
  return validPort(readRuntimeSnapshot(dbPath)?.port);
}

/**
 * 返回经过单实例锁和进程身份验证的活实例端口。
 */
function getActiveRuntimePort(
  dbPath: string,
  deps: {
    readInstanceMetadata?: (path: string) => InstanceMetadata | null;
    isInstanceAlive?: (metadata: InstanceMetadata) => boolean;
  } = {},
): number | null {
  if (!dbPath) return null;
  const lifecycle = require('./process-lifecycle');
  const readInstance = deps.readInstanceMetadata || lifecycle.readInstanceMetadata;
  const isAlive = deps.isInstanceAlive || lifecycle.isInstanceAlive;
  const instance = readInstance(dbPath);
  if (!instance || !isAlive(instance)) return null;

  const lockPort = validPort(instance.port);
  if (lockPort) return lockPort;

  const runtime = readRuntimeSnapshot(dbPath);
  if (!runtime) return null;
  const sameInstance = runtime.instanceId
    ? runtime.instanceId === instance.instanceId
    : runtime.pid === instance.pid;
  return sameInstance ? validPort(runtime.port) : null;
}

module.exports = { getRuntimePort, getActiveRuntimePort };
import type { InstanceMetadata } from './process-lifecycle';
