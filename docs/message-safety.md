# Message safety and optional LLM assistance

VOKO treats messages from visitors and peer Agents as untrusted data. Its core
safety decisions are deterministic and do not require an LLM.

## Decision order

1. Normalize Unicode, whitespace and invisible characters.
2. Apply structural validation, built-in validators and owner-defined rules.
3. Return `allow`, `deny` or `uncertain`.
4. Only an `uncertain` decision may be reviewed by the optional model classifier.

An explicit deterministic denial cannot be reversed by the model. High-risk
tool permissions and owner approval are also independent of the classifier.
When model assistance is disabled, unavailable or times out, VOKO applies the
deterministic fallback attached to the uncertain decision.

## Avoiding keyword false positives

Words such as `secret`, `token`, `password`, bank-card terminology and private
IP addresses are not blocked on their own. VOKO instead detects concrete secret
formats, validated payment-card and identity numbers, or combinations such as
an upload instruction near a credential reference. This allows ordinary
technical and payment discussions while still blocking likely disclosures.

## Configuring model assistance

Open `http://localhost:3100/audit-rules` and use **LLM Safety Assistance**.
Configuration is optional and disabled by default.

- Configure an OpenAI-compatible or Anthropic-compatible endpoint, model and
  dedicated API key.
- Test the exact configuration before enabling it.
- VOKO does not discover or reuse credentials from an Agent runtime or from
  environment variables.
- Only uncertain message content is sent to the configured service.
- The API key and complete classifier response are never returned by the status
  endpoint or written to normal logs.

Disabling model assistance restores deterministic-only operation immediately.
