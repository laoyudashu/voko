use thiserror::Error;

pub const E2EE_PROTOCOL_VERSION: u16 = 1;
pub const E2EE_CONTENT_TYPE: u16 = 13;
const MAX_FIELD_BYTES: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalAad {
    pub protocol_version: u16,
    pub content_type: u16,
    pub group_id: Vec<u8>,
    pub epoch: u64,
    pub target_agent_did: Vec<u8>,
    pub conversation_scope: Vec<u8>,
    pub sender_device_key_id: Vec<u8>,
    pub message_id: Vec<u8>,
    pub channel_type: u8,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AadError {
    #[error("AAD field is empty: {0}")]
    Empty(&'static str),
    #[error("AAD field exceeds {MAX_FIELD_BYTES} bytes: {0}")]
    TooLarge(&'static str),
}

impl CanonicalAad {
    pub fn encode(&self) -> Result<Vec<u8>, AadError> {
        let mut out = Vec::with_capacity(128);
        out.extend_from_slice(b"VOKO-E2EE-AAD\0");
        out.extend_from_slice(&self.protocol_version.to_be_bytes());
        out.extend_from_slice(&self.content_type.to_be_bytes());
        put(&mut out, "group_id", &self.group_id)?;
        out.extend_from_slice(&self.epoch.to_be_bytes());
        put(&mut out, "target_agent_did", &self.target_agent_did)?;
        put(&mut out, "conversation_scope", &self.conversation_scope)?;
        put(&mut out, "sender_device_key_id", &self.sender_device_key_id)?;
        put(&mut out, "message_id", &self.message_id)?;
        out.push(self.channel_type);
        Ok(out)
    }
}

fn put(out: &mut Vec<u8>, name: &'static str, value: &[u8]) -> Result<(), AadError> {
    if value.is_empty() {
        return Err(AadError::Empty(name));
    }
    if value.len() > MAX_FIELD_BYTES {
        return Err(AadError::TooLarge(name));
    }
    out.extend_from_slice(&(value.len() as u16).to_be_bytes());
    out.extend_from_slice(value);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> CanonicalAad {
        CanonicalAad {
            protocol_version: E2EE_PROTOCOL_VERSION,
            content_type: E2EE_CONTENT_TYPE,
            group_id: b"group-1".to_vec(),
            epoch: 7,
            target_agent_did: b"did:voko:agent-1".to_vec(),
            conversation_scope: b"conv-1".to_vec(),
            sender_device_key_id: b"device-key-1".to_vec(),
            message_id: b"message-1".to_vec(),
            channel_type: 1,
        }
    }

    #[test]
    fn encoding_is_deterministic_and_length_prefixed() {
        let first = sample().encode().unwrap();
        let second = sample().encode().unwrap();
        assert_eq!(first, second);
        assert!(first.starts_with(b"VOKO-E2EE-AAD\0"));
    }

    #[test]
    fn agent_binding_changes_authenticated_bytes() {
        let first = sample().encode().unwrap();
        let mut other = sample();
        other.target_agent_did = b"did:voko:agent-2".to_vec();
        assert_ne!(first, other.encode().unwrap());
    }

    #[test]
    fn rejects_empty_and_oversized_fields() {
        let mut aad = sample();
        aad.message_id.clear();
        assert_eq!(aad.encode(), Err(AadError::Empty("message_id")));
        aad.message_id = vec![1; MAX_FIELD_BYTES + 1];
        assert_eq!(aad.encode(), Err(AadError::TooLarge("message_id")));
    }
}
