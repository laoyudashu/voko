# OpenHands DeepSeek 配置：2026-09-05

用户已授权使用现有环境变量中的 DeepSeek key 自行配置大模型。Windows DEEPSEEK_API_KEY 存在；向官方 https://api.deepseek.com/models 验证返回 200，当前列表含 deepseek-v4-flash、deepseek-v4-pro、deepseek-v4-flash-vision-exp。未输出 key 值，也未将 key 放入命令参数、日志或仓库。

原生 OpenHands 本地模式通过 load_agent_specs 判断配置是否存在；此前 Authentication required 来自缺少 agent_settings.json，不是必须登录 OpenHands 云账号。实时确认目标文件不存在后，调用已安装 OpenHands 的 AgentStore.create_and_save_from_settings 创建配置：model=deepseek/deepseek-v4-flash，base_url=https://api.deepseek.com。使用受限临时目录序列化，以独占硬链接写入用户 .openhands/agent_settings.json，避免覆盖并发创建的配置。之后固定文件 ACL，仅当前 Windows 用户可访问（protected=true、inherited=false）。原生加载验证 key 与既有 DeepSeek 环境变量一致；有效 VOKO 环境覆盖同样使用该 key，没有额外模型覆盖。

23:45:20 UTC，实际 OpenHands ACP 原生回环 34941ms 完成，精确匹配随机挑战。隔离会话显式请求 always-ask 并确认成功，未观察到权限请求或拒绝事件；没有 Authentication required、401/403 或 quota 标记。测试只发送无工具的随机回显任务，停止测试进程并清理专用工作目录。

因此模型配置和基本模型调用已经通过，无需用户人工登录。但该结果没有验证所有新建/恢复会话的权限边界，也没有实际网页自动对话证据。VOKO OpenHands 当前 Catalog 仍为 Pull-only；未为消除失败状态而绕过限制，原 42/50 网页矩阵保持为历史事实。

两个 AUTO-REG 身份的问题是 Provider 类型未绑定，与模型 key 不同。已请求用户明确对应 Agent 类型，或授权选择已安装可用的 Provider。其余 Windows 原生崩溃/超时暂未取得必须人工登录的证据。

证据：artifacts/production-remediation-startup-20260905/windows-openhands-model-preflight.json、windows-openhands-configure-deepseek.json、windows-openhands-deepseek-loopback.json、windows-openhands-effective-config.json、windows-openhands-secure-config.json。这些记录仅含配置元数据、布尔值和验证结果，不含密钥。
