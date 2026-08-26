type SignedRequestFactory = (timestampSeconds: number) => Promise<RequestInit> | RequestInit;

interface ClockSample {
  offsetMs: number;
  sampledAtMs: number;
  monotonicAtMs: number;
}

interface ClockApiResponse {
  success?: boolean;
  serverTimeMs?: number;
}

const CLOCK_TTL_MS = 10 * 60 * 1000;
const MAX_CLOCK_RTT_MS = 5000;
const CLOCK_JUMP_MS = 30_000;
const samples = new Map<string, ClockSample>();
const refreshes = new Map<string, Promise<ClockSample | null>>();

function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function apiBase(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

function sampleIsFresh(sample: ClockSample | undefined, nowMs = Date.now()): sample is ClockSample {
  if (!sample || nowMs - sample.sampledAtMs > CLOCK_TTL_MS) return false;
  const wallElapsed = nowMs - sample.sampledAtMs;
  const monotonicElapsed = monotonicNow() - sample.monotonicAtMs;
  return Math.abs(wallElapsed - monotonicElapsed) <= CLOCK_JUMP_MS;
}

async function fetchClockSample(baseUrl: string, fetchImpl: typeof fetch): Promise<ClockSample | null> {
  const t0 = Date.now();
  const response = await fetchImpl(`${baseUrl}/api/external/v1/time`, {
    method: 'GET',
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  const t1 = Date.now();
  if (!response.ok || t1 - t0 > MAX_CLOCK_RTT_MS) return null;
  const body = await response.json() as ClockApiResponse;
  if (body.success !== true || !Number.isFinite(body.serverTimeMs)) return null;
  return {
    offsetMs: Number(body.serverTimeMs) - ((t0 + t1) / 2),
    sampledAtMs: t1,
    monotonicAtMs: monotonicNow(),
  };
}

async function clockSample(baseUrl: string, fetchImpl: typeof fetch, force = false): Promise<ClockSample | null> {
  const cached = samples.get(baseUrl);
  if (!force && sampleIsFresh(cached)) return cached;
  const active = refreshes.get(baseUrl);
  if (active) return active;
  const refresh = fetchClockSample(baseUrl, fetchImpl)
    .then((sample) => {
      if (sample) samples.set(baseUrl, sample);
      return sample;
    })
    .catch(() => null)
    .finally(() => refreshes.delete(baseUrl));
  refreshes.set(baseUrl, refresh);
  return refresh;
}

function signedTimestamp(sample: ClockSample | null): number {
  return Math.floor((Date.now() + (sample?.offsetMs || 0)) / 1000);
}

async function isClockSkewResponse(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  try {
    const body = await response.clone().json() as { error?: { code?: string }, message?: string };
    if (body.error?.code === 'CLOCK_SKEW') return true;
    return /timestamp|时间戳|允许范围|clock\s*skew/i.test(String(body.message || ''));
  } catch {
    return false;
  }
}

async function fetchWithDidClockRetry(
  url: string,
  buildRequest: SignedRequestFactory,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl || fetch;
  const baseUrl = apiBase(url);
  let sample = await clockSample(baseUrl, fetchImpl);
  let response = await fetchImpl(url, await buildRequest(signedTimestamp(sample)));
  if (!await isClockSkewResponse(response)) return response;

  sample = await clockSample(baseUrl, fetchImpl, true);
  if (!sample) return response;
  response = await fetchImpl(url, await buildRequest(signedTimestamp(sample)));
  return response;
}

function resetDidClockCacheForTests(): void {
  samples.clear();
  refreshes.clear();
}

module.exports = {
  fetchWithDidClockRetry,
  resetDidClockCacheForTests,
  sampleIsFresh,
  signedTimestamp,
};
