export {};

/**
 * VOKO MCP — McpServer 工厂
 *
 * 使用 @modelcontextprotocol/sdk 的 McpServer 注册 37 个工具。
 * 不自用 server.connect()——HTTP transport 直接处理 JSON-RPC 路由。
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');
const pkg = require('../../package.json');
const { t, getLocale } = require('../core/i18n');

type ToolHandler = (params: unknown) => Promise<unknown>;
type ToolHandlerMap = Record<string, ToolHandler>;

interface McpServerOptions {
  locale?: string;
  version?: string;
}

interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface ToolListResult {
  tools?: ToolDescriptor[];
}

interface McpServerWithToolList {
  server?: {
    _requestHandlers?: Map<string, (request: unknown) => Promise<ToolListResult>>;
  };
}

/**
 * 创建 McpServer，注册所有工具
 * @param {Object} toolHandlers — createToolHandlers(cx) 的返回值
 * @param {Object} [options]
 * @returns {McpServer}
 */
function createMcpServer(toolHandlers: ToolHandlerMap, options: McpServerOptions = {}) {
  const locale = options.locale || getLocale();
  const T = (key: string, params?: Record<string, unknown>) => t(key, params, locale);
  const server = new McpServer({
    name: 'voko',
    version: options.version || pkg.version,
  });

  // ─── 1. register_agent ───
  server.tool(
    'voko_register_agent',
    T('mcp.tool.register_agent.desc'),
    {
      email: z.string().email().describe(T('mcp.tool.register_agent.p.email')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.register_agent(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: true }
  );

  // ─── 2. verify_agent_email ───
  server.tool(
    'voko_verify_agent_email',
    T('mcp.tool.verify_agent_email.desc'),
    {
      email: z.string().email().describe(T('mcp.tool.verify_agent_email.p.email')),
      code: z.string().length(6).describe(T('mcp.tool.verify_agent_email.p.code')),
      agentId: z.string().optional().describe(T('mcp.tool.verify_agent_email.p.agentId')),
      agentName: z.string().optional().describe(T('mcp.tool.verify_agent_email.p.agentName')),
      backendType: z.string().optional().describe(T('mcp.tool.verify_agent_email.p.backendType')),
      category: z.string().optional().describe(T('mcp.tool.verify_agent_email.p.category')),
      description: z.string().optional().describe(T('mcp.tool.verify_agent_email.p.description')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.verify_agent_email(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: true }
  );

  // ─── 2b. 统一注册编排（Web / MCP / CLI 共用状态机）───
  server.tool(
    'voko_manage_agent_registration',
    T('mcp.tool.manage_agent_registration.desc'),
    {
      action: z.enum([
        'start', 'verify_email', 'set_basic_info', 'inspect_environment',
        'select_provider', 'select_delivery', 'configure_delivery',
        'configuration_status', 'test_delivery', 'complete', 'status',
      ]).describe(T('mcp.tool.manage_agent_registration.p.action')),
      registrationId: z.string().optional().describe(T('mcp.tool.manage_agent_registration.p.registrationId')),
      email: z.string().email().optional().describe(T('mcp.tool.register_agent.p.email')),
      code: z.string().length(6).optional().describe(T('mcp.tool.verify_agent_email.p.code')),
      agentName: z.string().optional().describe(T('mcp.tool.verify_agent_email.p.agentName')),
      description: z.string().optional().describe(T('mcp.tool.verify_agent_email.p.description')),
      category: z.string().optional().describe(T('mcp.tool.verify_agent_email.p.category')),
      providerType: z.string().optional().describe(T('mcp.tool.manage_agent_registration.p.providerType')),
      instanceId: z.string().optional().describe(T('mcp.tool.manage_agent_registration.p.instanceId')),
      deliveryModes: z.array(z.string()).optional().describe(T('mcp.tool.manage_agent_registration.p.deliveryModes')),
      mode: z.string().optional().describe(T('mcp.tool.manage_agent_registration.p.mode')),
      taskId: z.string().optional().describe(T('mcp.tool.manage_agent_registration.p.taskId')),
      approved: z.boolean().optional().describe(T('mcp.tool.manage_agent_registration.p.approved')),
      registrationMode: z.enum(['human', 'agent']).optional(),
    },
    async (params: unknown) => {
      const r = await toolHandlers.manage_agent_registration(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: true }
  );

  // ─── 3. update_agent_profile ───
  server.tool(
    'voko_update_agent_profile',
    T('mcp.tool.update_agent_profile.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      name: z.string().optional().describe(T('mcp.tool.update_agent_profile.p.name')),
      description: z.string().optional().describe(T('mcp.tool.update_agent_profile.p.description')),
      short_description: z.string().optional().describe(T('mcp.tool.update_agent_profile.p.short_description')),
      category: z.string().optional().describe(T('mcp.tool.update_agent_profile.p.category')),
      tags: z.string().optional().describe(T('mcp.tool.update_agent_profile.p.tags')),
      iconUrl: z.string().optional().describe(T('mcp.tool.update_agent_profile.p.iconUrl')),
      address: z.string().optional().describe(T('mcp.tool.update_agent_profile.p.address')),
      contact_phone: z.string().optional().describe(T('mcp.tool.update_agent_profile.p.contact_phone')),
      backendType: z.string().optional().describe(T('mcp.tool.update_agent_profile.p.backendType')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.update_agent_profile(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: true }
  );

  // ─── 4. set_agent_status ───
  server.tool(
    'voko_set_agent_status',
    T('mcp.tool.set_agent_status.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      status: z.number().int().min(0).max(1).optional().describe(T('mcp.tool.set_agent_status.p.status')),
      visibility: z.number().int().min(0).max(1).optional().describe(T('mcp.tool.set_agent_status.p.visibility')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.set_agent_status(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: true }
  );

  // ─── 5. get_status ───
  server.tool(
    'voko_get_status',
    T('mcp.tool.get_status.desc'),
    { agentId: z.string().describe(T('mcp.param.agentId')) },
    async (params: unknown) => {
      const r = await toolHandlers.get_status(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { readOnlyHint: true }
  );

  // ─── 5b. get_agent_profile ───
  server.tool(
    'voko_get_agent_profile',
    T('mcp.tool.get_agent_profile.desc'),
    { agentId: z.string().describe(T('mcp.param.agentId')) },
    async (params: unknown) => {
      const r = await toolHandlers.get_agent_profile(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { readOnlyHint: true }
  );

  // ─── 6. search_capabilities ───
  server.tool(
    'voko_search_capabilities',
    T('mcp.tool.search_capabilities.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      keyword: z.string().optional().describe(T('mcp.tool.search_capabilities.p.keyword')),
      page: z.number().int().min(1).optional().describe(T('mcp.tool.search_capabilities.p.page')),
      limit: z.number().int().min(1).max(100).optional().describe(T('mcp.tool.search_capabilities.p.limit')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.search_capabilities(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { readOnlyHint: true }
  );

  // ─── 7. declare_capabilities ───
  server.tool(
    'voko_declare_capabilities',
    T('mcp.tool.declare_capabilities.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      ability: z.array(z.object({
        name: z.string().describe(T('mcp.tool.declare_capabilities.p.ability.name')),
        description: z.string().optional().describe(T('mcp.tool.declare_capabilities.p.ability.description')),
        fields: z.array(z.object({
          field_name: z.string().describe(T('mcp.tool.declare_capabilities.p.ability.fields.field_name')),
          required: z.boolean().optional().describe(T('mcp.tool.declare_capabilities.p.ability.fields.required')),
          description: z.string().optional().describe(T('mcp.tool.declare_capabilities.p.ability.fields.description')),
        })).describe(T('mcp.tool.declare_capabilities.p.ability.fields')),
      })).describe(T('mcp.tool.declare_capabilities.p.ability')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.declare_capabilities(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: true }
  );

  // ─── 8. send_message ───
  server.tool(
    'voko_send_message',
    T('mcp.tool.send_message.desc'),
    {
      agentId: z.string().describe(T('mcp.tool.send_message.p.agentId')),
      toUid: z.string().describe(T('mcp.tool.send_message.p.toUid')),
      content: z.string().describe(T('mcp.tool.send_message.p.content')),
      contentType: z.number().optional().default(1).describe(T('mcp.tool.send_message.p.contentType')),
      channelType: z.number().optional().default(1).describe('频道类型：1=单聊（默认），2=群聊（toUid 为 channelId）'),
      mentions: z.object({ all: z.boolean().optional(), uids: z.array(z.string()).optional() }).optional().describe('群聊 @提及（channelType=2 时生效）'),
    },
    async (params: unknown) => {
      const r = await toolHandlers.send_message(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: false }
  );

  // ─── 9. get_chat_history ───
  server.tool(
    'voko_get_chat_history',
    T('mcp.tool.get_chat_history.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      channelId: z.string().describe(T('mcp.tool.get_chat_history.p.channelId')),
      channelType: z.number().optional().default(1).describe('频道类型：1=单聊（默认，按 agent_id 过滤），2=群聊（按 channel_id 查全量）'),
      keyword: z.string().optional().describe(T('mcp.tool.get_chat_history.p.keyword')),
      limit: z.number().optional().default(20).describe(T('mcp.tool.get_chat_history.p.limit')),
      offset: z.number().optional().default(0).describe(T('mcp.tool.get_chat_history.p.offset')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.get_chat_history(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { readOnlyHint: true }
  );

  // ─── 10. get_visitor_profile ───
  server.tool(
    'voko_get_visitor_profile',
    T('mcp.tool.get_visitor_profile.desc'),
    {
      visitorId: z.string().describe(T('mcp.tool.get_visitor_profile.p.visitorId')),
      agentId: z.string().optional().describe(T('mcp.tool.get_visitor_profile.p.agentId')),
      limit: z.number().int().min(1).max(50).optional().default(10).describe(T('mcp.tool.get_visitor_profile.p.limit')),
      offset: z.number().int().min(0).optional().default(0).describe(T('mcp.tool.get_visitor_profile.p.offset')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.get_visitor_profile(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { readOnlyHint: true }
  );

  // ─── 11. list_conversations ───
  server.tool(
    'voko_list_conversations',
    T('mcp.tool.list_conversations.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      filter: z.enum(['unreplied', 'all']).optional().default('unreplied').describe(T('mcp.tool.list_conversations.p.filter')),
      channelType: z.enum(['direct', 'group', 'all']).optional().default('all').describe('会话类型过滤：direct=单聊，group=群聊，all=全部'),
      limit: z.number().optional().default(20).describe(T('mcp.tool.list_conversations.p.limit')),
      offset: z.number().optional().default(0).describe(T('mcp.tool.list_conversations.p.offset')),
      keyword: z.string().optional().describe(T('mcp.tool.list_conversations.p.keyword')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.list_conversations(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { readOnlyHint: true }
  );

  // ─── 12. mark_conversation_read ───
  server.tool(
    'voko_mark_conversation_read',
    T('mcp.tool.mark_conversation_read.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      channelId: z.string().describe(T('mcp.tool.mark_conversation_read.p.channelId')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.mark_conversation_read(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
  );

  // ─── 13. get_upload_url ───
  server.tool(
    'voko_get_upload_url',
    T('mcp.tool.get_upload_url.desc'),
    {
      filePath: z.string().describe(T('mcp.tool.get_upload_url.p.filePath')),
      fileName: z.string().optional().describe(T('mcp.tool.get_upload_url.p.fileName')),
      contentType: z.string().optional().describe(T('mcp.tool.get_upload_url.p.contentType')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.get_upload_url(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: false }
  );

  // ─── 13. whoami ───
  server.tool(
    'voko_whoami',
    T('mcp.tool.whoami.desc'),
    {
      ownerEmail: z.string().optional().describe(T('mcp.tool.whoami.p.ownerEmail')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.whoami(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { readOnlyHint: true }
  );

  // ─── 14. start_worker / stop_worker ───
  server.tool(
    'voko_start_worker',
    T('mcp.tool.start_worker.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.start_worker(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: true }
  );
  server.tool(
    'voko_stop_worker',
    T('mcp.tool.stop_worker.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.stop_worker(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: true }
  );

  // ─── 15. ask_human_for_help ───
  server.tool(
    'voko_ask_human_for_help',
    T('mcp.tool.ask_human_for_help.desc'),
    {
      agentId: z.string().describe(T('mcp.tool.ask_human_for_help.p.agentId')),
      visitorId: z.string().describe(T('mcp.tool.ask_human_for_help.p.visitorId')),
      channelId: z.string().optional().describe(T('mcp.tool.ask_human_for_help.p.channelId')),
      channelType: z.number().int().min(1).max(2).optional().default(1).describe(T('mcp.tool.ask_human_for_help.p.channelType')),
      messageId: z.string().optional().describe(T('mcp.tool.ask_human_for_help.p.messageId')),
      problem: z.string().describe(T('mcp.tool.ask_human_for_help.p.problem')),
      suggestion: z.string().optional().describe(T('mcp.tool.ask_human_for_help.p.suggestion')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.ask_human_for_help(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: false }
  );

  // ─── 15. check_human_replies ───
  server.tool(
    'voko_check_human_replies',
    T('mcp.tool.check_human_replies.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      id: z.string().optional().describe(T('mcp.tool.check_human_replies.p.id')),
      visitorId: z.string().optional().describe(T('mcp.tool.check_human_replies.p.visitorId')),
      since: z.number().optional().describe(T('mcp.tool.check_human_replies.p.since')),
      limit: z.number().int().min(1).max(50).optional().default(20).describe(T('mcp.tool.check_human_replies.p.limit')),
      offset: z.number().int().min(0).optional().default(0).describe(T('mcp.tool.check_human_replies.p.offset')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.check_human_replies(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { readOnlyHint: true }
  );

  // ─── 16. close_human_request ───
  server.tool(
    'voko_close_human_request',
    T('mcp.tool.close_human_request.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      id: z.string().describe(T('mcp.tool.close_human_request.p.id')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.close_human_request(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: true }
  );

  // ─── 17. create_payment ───
  server.tool(
    'voko_create_payment',
    T('mcp.tool.create_payment.desc'),
    {
      agentId: z.string().describe(T('mcp.tool.create_payment.p.agentId')),
      visitorId: z.string().describe(T('mcp.tool.create_payment.p.visitorId')),
      amount: z.number().positive().describe(T('mcp.tool.create_payment.p.amount')),
      description: z.string().optional().describe(T('mcp.tool.create_payment.p.description')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.create_payment(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: true }
  );

  // ─── 18. check_payments ───
  server.tool(
    'voko_check_payments',
    T('mcp.tool.check_payments.desc'),
    {
      agentId: z.string().optional().describe(T('mcp.tool.check_payments.p.agentId')),
      orderId: z.string().optional().describe(T('mcp.tool.check_payments.p.orderId')),
      visitorId: z.string().optional().describe(T('mcp.tool.check_payments.p.visitorId')),
      status: z.string().optional().describe(T('mcp.tool.check_payments.p.status')),
      since: z.number().optional().describe(T('mcp.tool.check_payments.p.since')),
      limit: z.number().int().min(1).max(50).optional().default(20).describe(T('mcp.tool.check_payments.p.limit')),
      offset: z.number().int().min(0).optional().default(0).describe(T('mcp.tool.check_payments.p.offset')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.check_payments(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { readOnlyHint: true }
  );

  // ─── 19. add_payment_auth ───
  server.tool(
    'voko_add_payment_auth',
    T('mcp.tool.add_payment_auth.desc'),
    {
      name: z.string().describe(T('mcp.tool.add_payment_auth.p.name')),
      idCard: z.string().describe(T('mcp.tool.add_payment_auth.p.idCard')),
      bankCard: z.string().describe(T('mcp.tool.add_payment_auth.p.bankCard')),
      phone: z.string().describe(T('mcp.tool.add_payment_auth.p.phone')),
      bankCode: z.string().describe(T('mcp.tool.add_payment_auth.p.bankCode')),
      bankName: z.string().optional().describe(T('mcp.tool.add_payment_auth.p.bankName')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.add_payment_auth(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: true }
  );

  // ─── 20. list_payment_auth ───
  server.tool(
    'voko_list_payment_auth',
    T('mcp.tool.list_payment_auth.desc'),
    {
      keyword: z.string().optional().describe(T('mcp.tool.list_payment_auth.p.keyword')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.list_payment_auth(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { readOnlyHint: true }
  );

  // ─── 21. delete_payment_auth ───
  server.tool(
    'voko_delete_payment_auth',
    T('mcp.tool.delete_payment_auth.desc'),
    {
      id: z.string().describe(T('mcp.tool.delete_payment_auth.p.id')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.delete_payment_auth(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: true }
  );

  // ─── 22. apply_payment_auth ───
  server.tool(
    'voko_apply_payment_auth',
    T('mcp.tool.apply_payment_auth.desc'),
    {
      paymentAuthId: z.string().describe(T('mcp.tool.apply_payment_auth.p.paymentAuthId')),
      email: z.string().optional().describe(T('mcp.tool.apply_payment_auth.p.email')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.apply_payment_auth(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: true }
  );

  server.tool(
    'voko_refresh_payment_auth',
    T('mcp.tool.refresh_payment_auth.desc'),
    {
      paymentAuthId: z.string().describe(T('mcp.tool.refresh_payment_auth.p.paymentAuthId')),
      email: z.string().optional().describe(T('mcp.tool.refresh_payment_auth.p.email')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.refresh_payment_auth(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { readOnlyHint: true }
  );

  // ─── 23. search_banks ───
  server.tool(
    'voko_search_banks',
    T('mcp.tool.search_banks.desc'),
    {
      keyword: z.string().optional().describe(T('mcp.tool.search_banks.p.keyword')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.search_banks(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { readOnlyHint: true }
  );

  // ─── 24. bind_agent_payment_auth ───
  server.tool(
    'voko_bind_agent_payment_auth',
    T('mcp.tool.bind_agent_payment_auth.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      paymentAuthId: z.string().describe(T('mcp.tool.bind_agent_payment_auth.p.paymentAuthId')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.bind_agent_payment_auth(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: true }
  );

  // ─── 25. agent_pricing ───
  server.tool(
    'voko_agent_pricing',
    T('mcp.tool.agent_pricing.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      pricingModel: z.string().optional().describe(T('mcp.tool.agent_pricing.p.pricingModel')),
      price: z.number().positive().optional().describe(T('mcp.tool.agent_pricing.p.price')),
      durationMinutes: z.number().int().positive().optional().describe(T('mcp.tool.agent_pricing.p.durationMinutes')),
      trialMinutes: z.number().int().min(0).optional().describe(T('mcp.tool.agent_pricing.p.trialMinutes')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.agent_pricing(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: false }
  );

  // ─── 26. fetch_new_messages ───
  server.tool(
    'voko_fetch_new_messages',
    T('mcp.tool.fetch_new_messages.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      visitorId: z.string().optional().describe(T('mcp.tool.fetch_new_messages.p.visitorId')),
      channelId: z.string().optional().describe('群聊频道 ID（channelId）；与 channelType=2 配合查指定群聊'),
      channelType: z.number().optional().describe('频道类型：1=单聊，2=群聊'),
      messageSeq: z.number().optional().describe(T('mcp.tool.fetch_new_messages.p.messageSeq')),
      onlyReplies: z.boolean().optional().default(true).describe(T('mcp.tool.fetch_new_messages.p.onlyReplies')),
      limit: z.number().optional().default(50).describe(T('mcp.tool.fetch_new_messages.p.limit')),
      blockTimeout: z.number().optional().describe(T('mcp.tool.fetch_new_messages.p.blockTimeout')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.fetch_new_messages(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { readOnlyHint: true }
  );

  // ─── 27. 白名单管理 ───
  server.tool(
    'voko_manage_whitelist',
    T('mcp.tool.manage_whitelist.desc'),
    {
      agentId: z.string().optional().describe(T('mcp.tool.manage_whitelist.p.agentId')),
      action: z.enum(['add', 'remove']).describe(T('mcp.tool.manage_whitelist.p.action')),
      visitorId: z.string().optional().describe(T('mcp.tool.manage_whitelist.p.visitorId')),
      id: z.string().optional().describe(T('mcp.tool.manage_whitelist.p.id')),
      reason: z.string().optional().describe(T('mcp.tool.manage_whitelist.p.reason')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.manage_whitelist(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: true }
  );

  // ─── 28. 黑名单管理 ───
  server.tool(
    'voko_manage_blacklist',
    T('mcp.tool.manage_blacklist.desc'),
    {
      agentId: z.string().optional().describe(T('mcp.tool.manage_blacklist.p.agentId')),
      action: z.enum(['add', 'remove']).describe(T('mcp.tool.manage_blacklist.p.action')),
      visitorId: z.string().optional().describe(T('mcp.tool.manage_blacklist.p.visitorId')),
      id: z.string().optional().describe(T('mcp.tool.manage_blacklist.p.id')),
      reason: z.string().optional().describe(T('mcp.tool.manage_blacklist.p.reason')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.manage_blacklist(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: true }
  );

  // ─── 29. 查看黑白名单 ───
  server.tool(
    'voko_list_access_lists',
    T('mcp.tool.list_access_lists.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      listType: z.enum(['whitelist', 'blacklist']).describe(T('mcp.tool.list_access_lists.p.listType')),
      limit: z.number().optional().describe(T('mcp.tool.list_access_lists.p.limit')),
      offset: z.number().optional().default(0).describe(T('mcp.tool.list_access_lists.p.offset')),
      keyword: z.string().optional().describe(T('mcp.tool.list_access_lists.p.keyword')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.list_access_lists(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { readOnlyHint: true }
  );

  // ─── 30. 白名单模式 ───
  server.tool(
    'voko_set_private_mode',
    T('mcp.tool.set_private_mode.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      enabled: z.boolean().describe(T('mcp.tool.set_private_mode.p.enabled')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.set_private_mode(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: true }
  );

  // ─── 31. 邀请好友 ───
  server.tool(
    'voko_invite_friend',
    T('mcp.tool.invite_friend.desc'),
    {
      agentId: z.string().describe(T('mcp.tool.invite_friend.p.agentId')),
      friendEmail: z.string().describe(T('mcp.tool.invite_friend.p.friendEmail')),
      friendName: z.string().optional().describe(T('mcp.tool.invite_friend.p.friendName')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.invite_friend(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: true }
  );

  // ─── 32. 审核规则列表 ───
  server.tool(
    'voko_list_audit_rules',
    T('mcp.tool.list_audit_rules.desc'),
    {
      direction: z.enum(['inbound', 'outbound']).optional().describe(T('mcp.tool.list_audit_rules.p.direction')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.list_audit_rules(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { readOnlyHint: true }
  );

  // ─── 33. 审核规则管理（增删改） ───
  server.tool(
    'voko_manage_audit_rules',
    T('mcp.tool.manage_audit_rules.desc'),
    {
      action: z.enum(['add', 'update', 'delete']).describe(T('mcp.tool.manage_audit_rules.p.action')),
      ruleId: z.string().optional().describe(T('mcp.tool.manage_audit_rules.p.ruleId')),
      direction: z.enum(['inbound', 'outbound']).optional().describe(T('mcp.tool.manage_audit_rules.p.direction')),
      keyword: z.string().optional().describe(T('mcp.tool.manage_audit_rules.p.keyword')),
      actionType: z.enum(['hard_deny', 'soft_deny', 'allow']).optional().describe(T('mcp.tool.manage_audit_rules.p.actionType')),
      prompt: z.string().optional().describe(T('mcp.tool.manage_audit_rules.p.prompt')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.manage_audit_rules(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: true }
  );

  // ═════════════ 群聊（group chat）═════════════

  // ─── 34. create_group ───
  server.tool(
    'voko_create_group',
    T('mcp.tool.create_group.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      name: z.string().optional().describe(T('mcp.tool.create_group.p.name')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.create_group(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: true }
  );

  // ─── 35. invite_to_group ───
  server.tool(
    'voko_invite_to_group',
    T('mcp.tool.invite_to_group.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      channelId: z.string().describe(T('mcp.tool.invite_to_group.p.channelId')),
      members: z.array(z.string()).describe(T('mcp.tool.invite_to_group.p.members')),
      groupName: z.string().optional().describe(T('mcp.tool.invite_to_group.p.groupName')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.invite_to_group(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: false }
  );

  // ─── 36. accept_invitation ───
  server.tool(
    'voko_accept_invitation',
    T('mcp.tool.accept_invitation.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      channelId: z.string().describe(T('mcp.tool.accept_invitation.p.channelId')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.accept_invitation(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: true }
  );

  // ─── 37. decline_invitation ───
  server.tool(
    'voko_decline_invitation',
    T('mcp.tool.decline_invitation.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      channelId: z.string().describe(T('mcp.tool.decline_invitation.p.channelId')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.decline_invitation(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: false }
  );

  // ─── 38. get_group_members ───
  server.tool(
    'voko_get_group_members',
    T('mcp.tool.get_group_members.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      channelId: z.string().describe(T('mcp.tool.get_group_members.p.channelId')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.get_group_members(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { readOnlyHint: true }
  );

  // ─── 39. get_group_context ───
  server.tool(
    'voko_get_group_context',
    T('mcp.tool.get_group_context.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      channelId: z.string().describe(T('mcp.tool.get_group_context.p.channelId')),
      limit: z.number().optional().default(20).describe(T('mcp.tool.get_group_context.p.limit')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.get_group_context(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { readOnlyHint: true }
  );

  // ─── 40. kick_from_group ───
  server.tool(
    'voko_kick_from_group',
    T('mcp.tool.kick_from_group.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      channelId: z.string().describe(T('mcp.tool.kick_from_group.p.channelId')),
      targetUid: z.string().describe(T('mcp.tool.kick_from_group.p.targetUid')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.kick_from_group(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: true }
  );

  // ─── 41. quit_group ───
  server.tool(
    'voko_quit_group',
    T('mcp.tool.quit_group.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      channelId: z.string().describe(T('mcp.tool.quit_group.p.channelId')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.quit_group(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: true }
  );

  // ─── 42. update_group ───
  server.tool(
    'voko_update_group',
    T('mcp.tool.update_group.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      channelId: z.string().describe(T('mcp.tool.update_group.p.channelId')),
      name: z.string().optional().describe(T('mcp.tool.update_group.p.name')),
      notice: z.string().optional().describe(T('mcp.tool.update_group.p.notice')),
      avatar: z.string().optional().describe(T('mcp.tool.update_group.p.avatar')),
      approve_mode: z.string().optional().describe(T('mcp.tool.update_group.p.approve_mode')),
      searchable: z.number().optional().describe(T('mcp.tool.update_group.p.searchable')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.update_group(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: false }
  );

  // ─── 43. list_groups ───
  server.tool(
    'voko_list_groups',
    T('mcp.tool.list_groups.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      limit: z.number().optional().default(50).describe(T('mcp.tool.list_groups.p.limit')),
      offset: z.number().optional().default(0).describe(T('mcp.tool.list_groups.p.offset')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.list_groups(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { readOnlyHint: true }
  );

  // ─── 44. list_group_applies ───
  server.tool(
    'voko_list_group_applies',
    T('mcp.tool.list_group_applies.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      channelId: z.string().describe(T('mcp.tool.list_group_applies.p.channelId')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.list_group_applies(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { readOnlyHint: true }
  );

  // ─── 45. approve_group_apply ───
  server.tool(
    'voko_approve_group_apply',
    T('mcp.tool.approve_group_apply.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      channelId: z.string().describe(T('mcp.tool.approve_group_apply.p.channelId')),
      applyId: z.string().describe(T('mcp.tool.approve_group_apply.p.applyId')),
      action: z.enum(['approve','reject']).describe(T('mcp.tool.approve_group_apply.p.action')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.approve_group_apply(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: true }
  );

  // ─── 46. mute_member ───
  server.tool(
    'voko_mute_member',
    T('mcp.tool.mute_member.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      channelId: z.string().describe(T('mcp.tool.mute_member.p.channelId')),
      targetUid: z.string().describe(T('mcp.tool.mute_member.p.targetUid')),
      muted: z.boolean().describe(T('mcp.tool.mute_member.p.muted')),
      durationSeconds: z.number().optional().describe(T('mcp.tool.mute_member.p.durationSeconds')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.mute_member(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: true }
  );

  // ─── 47. search_groups ───
  server.tool(
    'voko_search_groups',
    T('mcp.tool.search_groups.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      keyword: z.string().describe(T('mcp.tool.search_groups.p.keyword')),
      page: z.number().optional().default(1).describe(T('mcp.tool.search_groups.p.page')),
      page_size: z.number().optional().default(20).describe(T('mcp.tool.search_groups.p.page_size')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.search_groups(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { readOnlyHint: true }
  );

  // ─── 48. apply_group ───
  server.tool(
    'voko_apply_group',
    T('mcp.tool.apply_group.desc'),
    {
      agentId: z.string().describe(T('mcp.param.agentId')),
      channelId: z.string().describe(T('mcp.tool.apply_group.p.channelId')),
      message: z.string().optional().describe(T('mcp.tool.apply_group.p.message')),
    },
    async (params: unknown) => {
      const r = await toolHandlers.apply_group(params);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
    { destructiveHint: false }
  );

  return server;
}

let _toolListCache: ToolDescriptor[] | null = null;
/**
 * 获取已注册工具的完整清单（含 name/description/inputSchema）。
 * 封装 SDK 私有 _requestHandlers 访问；memoize（工具在启动时注册固定）；
 * capability detect：SDK 若移除 _requestHandlers 则降级返回空数组，不抛错。
 */
async function getToolList(mcpServer?: McpServerWithToolList){
  if(_toolListCache)return _toolListCache;
  try{
    const h=mcpServer&&mcpServer.server&&mcpServer.server._requestHandlers&&mcpServer.server._requestHandlers.get('tools/list');
    const result=h?await h({method:'tools/list',params:{}}):{tools:[]};
    _toolListCache=(result&&result.tools)||[];
  }catch(e){_toolListCache=[]}
  return _toolListCache;
}

module.exports={createMcpServer,getToolList};
