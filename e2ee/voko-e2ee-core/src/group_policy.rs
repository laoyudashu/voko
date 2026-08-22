use serde::{Deserialize, Serialize};
use thiserror::Error;

const MAGIC: &[u8; 14] = b"VOKO-GROUP-001";
const MAX_FIELD: usize = 2048;
const MAX_TEXT: usize = 32 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[repr(u8)]
pub enum GroupOperation {
    Message = 1,
    MentionAll = 2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupRole {
    Member,
    Administrator,
    Owner,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupOperationMetadata {
    pub conversation_id: Vec<u8>,
    pub sender_device_key_id: Vec<u8>,
    pub operation: GroupOperation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EncryptedGroupContent {
    pub operation: GroupOperation,
    pub text: String,
    pub mentioned_member_key_ids: Vec<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum GroupPolicyError {
    #[error("invalid group operation metadata")]
    InvalidMetadata,
    #[error("sender is not allowed to mention all members")]
    MentionAllForbidden,
    #[error("encrypted group content does not match authenticated metadata")]
    OperationMismatch,
}

impl GroupOperationMetadata {
    /// These bytes are both visible to the delivery service and embedded
    /// verbatim in MLS authenticated_data as the conversation scope.
    pub fn encode(&self) -> Result<Vec<u8>, GroupPolicyError> {
        validate_field(&self.conversation_id)?;
        validate_field(&self.sender_device_key_id)?;
        let mut output = Vec::with_capacity(64);
        output.extend_from_slice(MAGIC);
        put(&mut output, &self.conversation_id)?;
        put(&mut output, &self.sender_device_key_id)?;
        output.push(self.operation as u8);
        Ok(output)
    }

    pub fn decode(input: &[u8]) -> Result<Self, GroupPolicyError> {
        if !input.starts_with(MAGIC) {
            return Err(GroupPolicyError::InvalidMetadata);
        }
        let mut cursor = MAGIC.len();
        let conversation_id = take(input, &mut cursor)?;
        let sender_device_key_id = take(input, &mut cursor)?;
        let operation = match input.get(cursor) {
            Some(1) => GroupOperation::Message,
            Some(2) => GroupOperation::MentionAll,
            _ => return Err(GroupPolicyError::InvalidMetadata),
        };
        cursor += 1;
        if cursor != input.len() {
            return Err(GroupPolicyError::InvalidMetadata);
        }
        Ok(Self {
            conversation_id,
            sender_device_key_id,
            operation,
        })
    }

    pub fn authorize(&self, role: GroupRole) -> Result<(), GroupPolicyError> {
        if self.operation == GroupOperation::MentionAll
            && !matches!(role, GroupRole::Administrator | GroupRole::Owner)
        {
            return Err(GroupPolicyError::MentionAllForbidden);
        }
        Ok(())
    }

    pub fn verify_decrypted_content(
        &self,
        content: &EncryptedGroupContent,
    ) -> Result<(), GroupPolicyError> {
        if content.operation != self.operation
            || content.text.is_empty()
            || content.text.len() > MAX_TEXT
            || content.mentioned_member_key_ids.len() > 1000
            || content.mentioned_member_key_ids.iter().any(|value| {
                value.is_empty() || value.len() > MAX_FIELD || value.chars().any(char::is_control)
            })
        {
            return Err(GroupPolicyError::OperationMismatch);
        }
        Ok(())
    }
}

fn validate_field(value: &[u8]) -> Result<(), GroupPolicyError> {
    if value.is_empty() || value.len() > MAX_FIELD {
        return Err(GroupPolicyError::InvalidMetadata);
    }
    Ok(())
}

fn put(output: &mut Vec<u8>, value: &[u8]) -> Result<(), GroupPolicyError> {
    validate_field(value)?;
    output.extend_from_slice(&(value.len() as u16).to_be_bytes());
    output.extend_from_slice(value);
    Ok(())
}

fn take(input: &[u8], cursor: &mut usize) -> Result<Vec<u8>, GroupPolicyError> {
    let length: [u8; 2] = input
        .get(*cursor..*cursor + 2)
        .ok_or(GroupPolicyError::InvalidMetadata)?
        .try_into()
        .map_err(|_| GroupPolicyError::InvalidMetadata)?;
    *cursor += 2;
    let length = u16::from_be_bytes(length) as usize;
    let value = input
        .get(*cursor..*cursor + length)
        .ok_or(GroupPolicyError::InvalidMetadata)?
        .to_vec();
    *cursor += length;
    validate_field(&value)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mention_all_is_visible_authenticated_and_role_gated() {
        let metadata = GroupOperationMetadata {
            conversation_id: b"group-conversation".to_vec(),
            sender_device_key_id: b"opaque-device-key".to_vec(),
            operation: GroupOperation::MentionAll,
        };
        let encoded = metadata.encode().unwrap();
        assert_eq!(GroupOperationMetadata::decode(&encoded).unwrap(), metadata);
        assert_eq!(
            metadata.authorize(GroupRole::Member),
            Err(GroupPolicyError::MentionAllForbidden)
        );
        metadata.authorize(GroupRole::Administrator).unwrap();
        metadata.authorize(GroupRole::Owner).unwrap();
    }

    #[test]
    fn receiver_rejects_outer_and_encrypted_operation_mismatch() {
        let metadata = GroupOperationMetadata {
            conversation_id: b"group-conversation".to_vec(),
            sender_device_key_id: b"opaque-device-key".to_vec(),
            operation: GroupOperation::Message,
        };
        let content = EncryptedGroupContent {
            operation: GroupOperation::MentionAll,
            text: "hidden group text".into(),
            mentioned_member_key_ids: vec![],
        };
        assert_eq!(
            metadata.verify_decrypted_content(&content),
            Err(GroupPolicyError::OperationMismatch)
        );
    }
}
