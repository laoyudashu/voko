# 百度搭子（DuMate）Provider

VOKO 可以发现本机 DuMate 用户 Agent（Plugin Pack），注册时绑定到指定实例，并通过独立的本机回环服务进行精准对话和原生会话续接。

## 支持范围

- 发现：扫描 DuMate `qianfan_desk_xdg/*/data/plugins/user/*` 下的用户 Plugin Pack。
- 注册：保存稳定的 Plugin Pack `name` 为 `backend_instance_id`，例如 `stock-assistant`。
- 精准路由：首次消息发送 DuMate `{ "type": "plugin", "name": "stock-assistant" }` 部件。
- 回复：读取原生会话中 `phase: "final_answer"` 的文本。
- Resume：持久化 DuMate `sessionId`，后续消息复用该会话。
- 隔离：VOKO 启动独立 `dumate-opencode serve`，只监听 `127.0.0.1`，不暴露到局域网。

安装了桌面应用或存在 `dumate-opencode` 文件不等于已经登录。VOKO 会先检查桌面后端是否就绪，
再检查合法 Plugin Pack；桌面后端未就绪时优先提示用户打开应用并完成登录，而不是误报缺少 Agent。
只有桌面后端端口可用、发现合法 Plugin Pack，并由主人明确执行一次真实回路测试确认认证可用后，才启用 HTTP 自动投递。
在此之前状态保持 `configuration_required`，Pull 仍可使用。

## 发现与注册契约

实例目录名必须与 `.claude-plugin/plugin.json` 的 `name` 一致；清单中必须存在同名 Agent；Agent 的 `prompt` 必须指向 Plugin Pack 内真实存在的 Markdown 文件。无效、越界或重复的清单不会显示在注册页面。

`股票小助手` 的稳定实例 ID 是 `stock-assistant`，注册后保存为 `backend_instance_id`。

## 精准路由与 Resume

`stock-assistant` 不是普通 OpenCode Agent，不能使用 `--agent stock-assistant`。该参数找不到实例时会回退默认 Agent，无法满足精准路由。

VOKO 在新会话首条消息中发送：

```json
{
  "agent": "build",
  "parts": [
    { "type": "plugin", "name": "stock-assistant" },
    { "type": "text", "text": "访客消息" }
  ]
}
```

发送后必须验证 `activePlugins` 包含所选实例。Resume 同时校验 provider、adapter、实例 ID、原生 `sessionId` 和 `activePlugins`；任一条件不满足都停止投递，不允许回退默认 Agent。

## 运行时与安全

Windows 默认发现：

```text
C:\Program Files\DuMate\resources\extra-resource\opencode\bin\dumate-opencode.exe
```

macOS 默认发现：

```text
/Applications/DuMate.app/Contents/Resources/extra-resource/opencode/bin/dumate-opencode
```

可通过 `VOKO_DUMATE_CLI_BIN` 覆盖。Provider 在 `~/.voko/provider-data/dumate/<instanceId>` 为每个 Agent 建立独立且持久的数据目录，仅复制所选 Plugin Pack；服务重启后仍能恢复原生 session。服务启动后调用 `/global/runtime/ready`。

已有合法 Plugin Pack、但隔离的 `dumate-opencode serve` 尚未运行时，VOKO 会在首次真实投递时自动启动它。
如果不存在 Plugin Pack，VOKO 不会伪造一个百度搭子 Agent；应先通过百度搭子支持的创建流程生成实例。

DuMate 官方当前只提供 macOS 和 Windows 桌面客户端。Linux 不扫描虚构的默认路径，也不把 PATH 中偶然同名的程序当作已安装；只有显式配置 `VOKO_DUMATE_CLI_BIN` 并通过运行时预检时才启用。

- 服务只监听随机本机回环端口。当前 DuMate 内部 DB 回调不会携带 `OPENCODE_SERVER_PASSWORD`，启用该变量会导致自身请求返回 401，因此 Provider 不虚报认证能力，也不允许非回环监听。
- 不连接 DuMate 桌面私有服务，不读取内部 `DUMATE_INAPP_KEY`。
- 实例、会话或 `activePlugins` 不匹配时 fail closed。

## ACP 状态

DuMate ACP v1 的握手、建会话和提示已经真实验收，但当前版本出现过 ACP 最终消息事件为空、HTTP 原生会话中实际存在最终文本的问题；标准 ACP 也未验证出 Plugin Part 的正式映射。因此当前 Provider 使用已验收的 HTTP 会话接口完成精准路由和 Resume，不把 ACP 作为生产主通道。
