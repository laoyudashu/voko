export {};

type BugReportParams = {
  action?: string;
  reportId?: string;
  queryToken?: string;
  title?: string;
  description?: string;
  steps?: string;
  expected?: string;
  actual?: string;
  severity?: string;
  category?: string;
  agentId?: string;
  agentType?: string;
  ownerEmail?: string;
  source?: string;
};

type BugReportClientOptions = {
  apiBaseUrl: string;
  db?: any;
};

function clean(value: unknown, max: number): string {
  return String(value || '').replace(/\0/g, '').trim().slice(0, max);
}

function metadataFromDb(db: any, agentId?: string) {
  if (!db || !agentId) return {};
  try {
    const row = db.prepare(
      'SELECT agent_id, backend_type, owner_email FROM agents WHERE agent_id = ? LIMIT 1'
    ).get(agentId);
    return row ? { agentId: row.agent_id, agentType: row.backend_type || 'others', ownerEmail: row.owner_email || '' } : {};
  } catch {
    return {};
  }
}

function createBugReportClient({ apiBaseUrl, db }: BugReportClientOptions) {
  const endpoint = `${String(apiBaseUrl || '').replace(/\/+$/, '')}/api/external/v1/bug-report`;
  const clientVersion = require('../../package.json').version;

  return async function bugReport(params: BugReportParams = {}) {
    const action = params.action === 'query' ? 'query' : 'submit';
    if (!apiBaseUrl) return { success: false, error: 'VOKO API URL is not configured' };

    let body: Record<string, unknown>;
    if (action === 'query') {
      const reportId = clean(params.reportId, 64);
      const queryToken = clean(params.queryToken, 160);
      if (!reportId || !queryToken) return { success: false, error: 'reportId and queryToken are required' };
      body = { action, reportId, queryToken };
    } else {
      const title = clean(params.title, 160);
      const description = clean(params.description, 8000);
      if (!title || !description) return { success: false, error: 'title and description are required' };
      const detected = metadataFromDb(db, clean(params.agentId, 64));
      body = {
        action,
        title,
        description,
        steps: clean(params.steps, 4000),
        expected: clean(params.expected, 2000),
        actual: clean(params.actual, 2000),
        severity: ['low', 'medium', 'high', 'critical'].includes(String(params.severity))
          ? params.severity
          : 'medium',
        category: ['bug', 'crash', 'ui', 'performance', 'compatibility', 'other'].includes(String(params.category))
          ? params.category
          : 'bug',
        clientVersion,
        platform: process.platform,
        agentId: clean(params.agentId || detected.agentId, 64),
        agentType: clean(params.agentType || detected.agentType, 64),
        ownerEmail: clean(params.ownerEmail || detected.ownerEmail, 254),
        source: clean(params.source || 'lite', 32),
      };
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const result: any = await response.json().catch(() => ({}));
        if (!response.ok || result.success === false) {
          const structuredError = result.error && typeof result.error === 'object' ? result.error : null;
          return {
            success: false,
            error: clean(structuredError?.message || result.error || result.message || `HTTP ${response.status}`, 500),
            ...(structuredError?.code ? { code: clean(structuredError.code, 80) } : {}),
          };
        }
        return result;
      } finally {
        clearTimeout(timer);
      }
    } catch (error: any) {
      return { success: false, error: error?.name === 'AbortError' ? 'Request timed out' : clean(error?.message, 500) };
    }
  };
}

module.exports = { createBugReportClient };
