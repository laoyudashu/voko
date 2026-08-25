# MCP message and routing Conversation contract

[Documentation index](README.md) · [MCP/CLI runtime](mcp-cli-runtime.md)

This document is the canonical Agent-facing contract for VOKO message history, receiving, sending, attachments, owner intervention, and precise routing Conversations.

## Two different meanings of “conversation”

VOKO deliberately exposes two separate discovery tools:

| Tool | Meaning | Typical use |
|---|---|---|
| `voko_list_conversations` | Direct-chat peers and group channels from the legacy/UI conversation list | Find who or which group has messages |
| `voko_list_routing_conversations` | Precise VOKO routing Conversations inside one Agent and channel | Select a Provider Session context when the same channel has multiple contexts |

Do not treat the result of `voko_list_conversations` as a Provider Session. VOKO never exposes Provider-native session/thread IDs through these tools.

## Compatibility contract

All new routing inputs are optional:

- Existing callers that do not send `conversationId` keep their channel-level behavior.
- Existing callers may ignore additional response fields.
- Old or unrouted messages remain readable and return `conversationId: null`.
- Only an explicitly supplied invalid, cross-Agent, or cross-channel `conversationId` fails closed.
- `whoami` and `list_agents` identify an Agent; they do not discover message Conversations.

## Recommended decision order

For every reply or outbound message:

```text
replyToMessageId
  > explicit conversationId
  > trusted caller Session resolution/creation
  > compatible channel-level path
```

Use `replyToMessageId` when replying to a concrete message. It is safer than manually carrying a Conversation because VOKO validates the stored MessageRoute. Use `conversationId` when deliberately continuing or selecting one known context. On the first proactive message, both may be omitted; VOKO resolves or creates a Conversation when trusted caller evidence is available.

## Discover channels and routing Conversations

### `voko_list_conversations`

Lists direct-chat peers and groups. Its existing parameters and response semantics are unchanged. Use `filter: "all"` when already-replied channels must also be shown.

### `voko_list_routing_conversations`

Required parameters:

```json
{
  "agentId": "<VOKO Agent ID>",
  "channelId": "<peer UID or group channel ID>",
  "channelType": 1
}
```

Optional pagination: `limit` (1–100) and `offset`.

The response contains only safe VOKO identifiers and lifecycle metadata:

```json
{
  "success": true,
  "channelId": "peer-uid",
  "channelType": 1,
  "total": 2,
  "hasMore": false,
  "conversations": [
    {
      "conversationId": "<VOKO Conversation ID>",
      "status": "active",
      "origin": "caller",
      "createdAt": 0,
      "updatedAt": 0,
      "lastUsedAt": 0
    }
  ]
}
```

Native Provider sessions, fingerprints, credentials, and local paths are never returned.

## Read history

### `voko_get_chat_history`

Channel-level compatible query:

```json
{
  "agentId": "agent-id",
  "channelId": "peer-uid",
  "channelType": 1,
  "limit": 20,
  "offset": 0
}
```

Precise query adds:

```json
{ "conversationId": "<VOKO Conversation ID>" }
```

When omitted, history remains scoped to the Agent and channel. When supplied, VOKO validates its Agent/channel scope and filters by MessageRoute before applying pagination. Every returned message includes a nullable `conversationId`:

```json
{
  "id": "message-id",
  "channelId": "peer-uid",
  "channelType": 1,
  "conversationId": null,
  "content": "..."
}
```

`conversationId: null` means the historical message has no precise routing record; it is not an error.

## Receive new messages

### `voko_fetch_new_messages`

Cursor, blocking, `onlyReplies`, private/group, and legacy client behavior are unchanged. Each returned message now also contains nullable `conversationId`.

If a precise Session-scoped Pull route exists, only the matching trusted caller Session receives the actionable message. A legacy caller without trusted Session evidence retains the compatible shared-cursor behavior. Never invent a Conversation from the most recently active Session.

## Send text, images, or public files

### `voko_send_message`

The existing required fields remain `agentId`, `toUid`, and `content`. Optional routing fields are:

```json
{
  "conversationId": "<known VOKO Conversation ID>",
  "replyToMessageId": "<message being answered>"
}
```

If both are supplied, the verified reply target takes precedence. A successful response always includes these nullable additions:

```json
{
  "messageId": "message-id",
  "conversationId": "<VOKO Conversation ID or null>",
  "conversationStatus": "active",
  "conversationDisposition": "reused"
}
```

Private IM sends also report the selected transport security without adding a required input:

```json
{
  "securityMode": "e2ee",
  "securityReason": "recipient_supported",
  "encryptedDeviceCount": 2,
  "deliveryState": "delivered"
}
```

`securityMode` is `e2ee` or `plaintext`; `deliveryState` is `delivered`, `queued`, or `partial`. A never-encrypted peer may use plaintext when it is confirmed unsupported or temporarily unavailable. A Conversation that has already used E2EE fails closed instead of silently downgrading. Groups do not enter this private-message decision path.

`conversationDisposition` is `created`, `reused`, or `null`. A null Conversation means the compatible channel-level send succeeded without a precise Provider Session association.

## Upload and send a local attachment

### `voko_upload_and_send_file`

The tool accepts the same optional `conversationId` and `replyToMessageId`. If `message` is supplied with the attachment, the text and attachment use the same selected Conversation, recipient-device snapshot, and security mode. Its response includes `messageId`, optional `textMessageId`, the same nullable Conversation fields as `voko_send_message`, and the security fields above.

Do not use `voko_send_message` to upload a local path. It may send an image or file that already has a public URL; local files must use `voko_upload_and_send_file`.

## Owner intervention

### `voko_ask_human_for_help`

The tool accepts the legacy `messageId` and the new routing inputs:

```json
{
  "replyToMessageId": "<preferred source message>",
  "conversationId": "<explicit fallback Conversation>"
}
```

Resolution order is the verified source message, explicit Conversation, then the unique active Conversation in scope. Multiple candidates are never resolved by choosing the most recent Session. The response returns:

```json
{
  "success": true,
  "interventionId": "...",
  "conversationId": "<VOKO Conversation ID or null>"
}
```

`voko_check_human_replies` returns the retained nullable `conversationId` on every intervention so the Agent can continue the same context.

## Private chat, groups, and exact replies

- Private chat validates Agent, peer UID, channel type, channel ID, Route status, expiry, and Conversation status.
- Group chat keeps one shared timeline. Exact return routing requires a legal reply Route and supported Provider turn correlation.
- A present-but-invalid Route fails closed; it does not fall back to the latest Session or an old binding.
- A group message without a precise Route retains the existing mention/Pull behavior.
- `@all` still follows group owner/admin authorization and does not create multiple precise Routes from one `replyToRouteId`.

## Minimal Agent workflow

```text
whoami (or explicit agentId)
  → list_conversations
  → fetch_new_messages or get_chat_history
  → reply with replyToMessageId
  → keep returned conversationId for deliberate continuation
  → list_routing_conversations only when multiple contexts must be selected
```

An Agent does not generate a `conversationId`, does not use a Provider-native thread ID as a VOKO ID, and does not need a Conversation for ordinary compatible channel-level calls.
