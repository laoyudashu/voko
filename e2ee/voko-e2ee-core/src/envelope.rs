use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{CanonicalAad, E2EE_CONTENT_TYPE, E2EE_PROTOCOL_VERSION};

pub const MAX_TEXT_CIPHERTEXT_BYTES: usize = 256 * 1024;
const MAX_ROUTING_FIELD_BYTES: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WireEnvelope {
    pub version: String,
    pub content_type: u16,
    pub group_id: String,
    pub epoch: u64,
    pub target_agent_did: String,
    pub conversation_scope: String,
    pub sender_device_key_id: String,
    pub message_id: String,
    pub channel_type: u8,
    pub ciphertext: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum EnvelopeError {
    #[error("unsupported E2EE envelope version or content type")]
    Unsupported,
    #[error("invalid E2EE routing field: {0}")]
    InvalidField(&'static str),
    #[error("invalid E2EE ciphertext encoding")]
    InvalidCiphertext,
    #[error("E2EE ciphertext exceeds the text-message limit")]
    CiphertextTooLarge,
}

impl WireEnvelope {
    pub fn new(aad: &CanonicalAad, ciphertext: &[u8]) -> Result<Self, EnvelopeError> {
        let envelope = Self {
            version: "voko.e2ee/1".into(),
            content_type: aad.content_type,
            group_id: text("groupId", &aad.group_id)?,
            epoch: aad.epoch,
            target_agent_did: text("targetAgentDid", &aad.target_agent_did)?,
            conversation_scope: text("conversationScope", &aad.conversation_scope)?,
            sender_device_key_id: text("senderDeviceKeyId", &aad.sender_device_key_id)?,
            message_id: text("messageId", &aad.message_id)?,
            channel_type: aad.channel_type,
            ciphertext: STANDARD_NO_PAD.encode(ciphertext),
        };
        envelope.validate()?;
        Ok(envelope)
    }

    pub fn validate(&self) -> Result<(), EnvelopeError> {
        if self.version != "voko.e2ee/1"
            || self.content_type != E2EE_CONTENT_TYPE
            || self.channel_type != 1
        {
            return Err(EnvelopeError::Unsupported);
        }
        validate_text("groupId", &self.group_id)?;
        validate_text("targetAgentDid", &self.target_agent_did)?;
        validate_text("conversationScope", &self.conversation_scope)?;
        validate_text("senderDeviceKeyId", &self.sender_device_key_id)?;
        validate_text("messageId", &self.message_id)?;
        let decoded = self.ciphertext_bytes()?;
        if decoded.is_empty() {
            return Err(EnvelopeError::InvalidCiphertext);
        }
        Ok(())
    }

    pub fn aad(&self) -> Result<CanonicalAad, EnvelopeError> {
        self.validate()?;
        Ok(CanonicalAad {
            protocol_version: E2EE_PROTOCOL_VERSION,
            content_type: self.content_type,
            group_id: self.group_id.as_bytes().to_vec(),
            epoch: self.epoch,
            target_agent_did: self.target_agent_did.as_bytes().to_vec(),
            conversation_scope: self.conversation_scope.as_bytes().to_vec(),
            sender_device_key_id: self.sender_device_key_id.as_bytes().to_vec(),
            message_id: self.message_id.as_bytes().to_vec(),
            channel_type: self.channel_type,
        })
    }

    pub fn ciphertext_bytes(&self) -> Result<Vec<u8>, EnvelopeError> {
        if self.ciphertext.len() > MAX_TEXT_CIPHERTEXT_BYTES * 2 {
            return Err(EnvelopeError::CiphertextTooLarge);
        }
        let decoded = STANDARD_NO_PAD
            .decode(&self.ciphertext)
            .map_err(|_| EnvelopeError::InvalidCiphertext)?;
        if decoded.len() > MAX_TEXT_CIPHERTEXT_BYTES {
            return Err(EnvelopeError::CiphertextTooLarge);
        }
        Ok(decoded)
    }
}

fn text(name: &'static str, value: &[u8]) -> Result<String, EnvelopeError> {
    let value = std::str::from_utf8(value).map_err(|_| EnvelopeError::InvalidField(name))?;
    validate_text(name, value)?;
    Ok(value.to_owned())
}

fn validate_text(name: &'static str, value: &str) -> Result<(), EnvelopeError> {
    if value.is_empty()
        || value.len() > MAX_ROUTING_FIELD_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(EnvelopeError::InvalidField(name));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn aad() -> CanonicalAad {
        CanonicalAad {
            protocol_version: E2EE_PROTOCOL_VERSION,
            content_type: E2EE_CONTENT_TYPE,
            group_id: b"group-envelope".to_vec(),
            epoch: 1,
            target_agent_did: b"did:voko:agent-envelope".to_vec(),
            conversation_scope: b"conversation-envelope".to_vec(),
            sender_device_key_id: b"browser-key-envelope".to_vec(),
            message_id: b"message-envelope".to_vec(),
            channel_type: 1,
        }
    }

    #[test]
    fn round_trip_preserves_authenticated_routing() {
        let envelope = WireEnvelope::new(&aad(), b"opaque ciphertext").unwrap();
        assert_eq!(envelope.aad().unwrap(), aad());
        assert_eq!(envelope.ciphertext_bytes().unwrap(), b"opaque ciphertext");
    }

    #[test]
    fn unknown_fields_and_oversized_ciphertext_fail_closed() {
        let json =
            serde_json::to_string(&WireEnvelope::new(&aad(), b"ciphertext").unwrap()).unwrap();
        let tampered = json.replacen('{', "{\"unknown\":true,", 1);
        assert!(serde_json::from_str::<WireEnvelope>(&tampered).is_err());
        let mut envelope = WireEnvelope::new(&aad(), b"ciphertext").unwrap();
        envelope.ciphertext = "A".repeat(MAX_TEXT_CIPHERTEXT_BYTES * 2 + 1);
        assert_eq!(envelope.validate(), Err(EnvelopeError::CiphertextTooLarge));
    }
}
