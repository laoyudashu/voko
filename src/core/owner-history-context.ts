import { AsyncLocalStorage } from 'node:async_hooks';
// Set only by the Web router after resolving its authenticated session. Never
// derive this capability from MCP parameters, caller headers or instance tokens.
const ownerHistory = new AsyncLocalStorage<boolean>();
export function withOwnerHistory<T>(callback: () => T): T { return ownerHistory.run(true, callback); }
export function isOwnerHistory(): boolean { return ownerHistory.getStore() === true; }
