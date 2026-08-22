use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::Zeroizing;

use crate::{EncryptedVault, VaultError, VaultKdfParams};

const FORMAT_VERSION: u16 = 1;
const MAX_MESSAGES: usize = 100_000;
const MAX_FIELD_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchivedMessage {
    pub conversation_id: String,
    pub message_id: String,
    pub sender_key_id: String,
    pub created_at_ms: u64,
    pub plaintext: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadOnlyArchive {
    package_id: [u8; 16],
    prior_device_key_id: String,
    prior_key_epoch: u64,
    messages: Vec<ArchivedMessage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplacementDeviceRequirement {
    pub revoked_device_key_id: String,
    pub minimum_new_key_epoch: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArchivePayload {
    version: u16,
    package_id: [u8; 16],
    prior_device_key_id: String,
    prior_key_epoch: u64,
    messages: Vec<ArchivedMessage>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RecoveryError {
    #[error("invalid read-only recovery archive")]
    InvalidArchive,
    #[error("recovery archive exceeds its safety limits")]
    TooLarge,
    #[error("replacement device epoch must advance")]
    EpochMustAdvance,
    #[error("recovery archive authentication failed")]
    AuthenticationFailed,
}

impl ReadOnlyArchive {
    pub fn export(
        prior_device_key_id: &str,
        prior_key_epoch: u64,
        messages: Vec<ArchivedMessage>,
        recovery_secret: &[u8],
    ) -> Result<Vec<u8>, RecoveryError> {
        validate(prior_device_key_id, &messages)?;
        let mut package_id = [0u8; 16];
        OsRng.fill_bytes(&mut package_id);
        let payload = ArchivePayload {
            version: FORMAT_VERSION,
            package_id,
            prior_device_key_id: prior_device_key_id.to_owned(),
            prior_key_epoch,
            messages,
        };
        let serialized = Zeroizing::new(
            serde_json::to_vec(&payload).map_err(|_| RecoveryError::InvalidArchive)?,
        );
        EncryptedVault::seal(&serialized, recovery_secret, VaultKdfParams::default())
            .map_err(map_vault_error)
    }

    pub fn import(sealed: &[u8], recovery_secret: &[u8]) -> Result<Self, RecoveryError> {
        let plaintext = EncryptedVault::open(sealed, recovery_secret).map_err(map_vault_error)?;
        let payload: ArchivePayload =
            serde_json::from_slice(&plaintext).map_err(|_| RecoveryError::InvalidArchive)?;
        if payload.version != FORMAT_VERSION {
            return Err(RecoveryError::InvalidArchive);
        }
        validate(&payload.prior_device_key_id, &payload.messages)?;
        Ok(Self {
            package_id: payload.package_id,
            prior_device_key_id: payload.prior_device_key_id,
            prior_key_epoch: payload.prior_key_epoch,
            messages: payload.messages,
        })
    }

    pub fn package_id(&self) -> [u8; 16] {
        self.package_id
    }

    pub fn messages(&self) -> &[ArchivedMessage] {
        &self.messages
    }

    pub fn replacement_requirement(&self) -> ReplacementDeviceRequirement {
        ReplacementDeviceRequirement {
            revoked_device_key_id: self.prior_device_key_id.clone(),
            minimum_new_key_epoch: self.prior_key_epoch.saturating_add(1),
        }
    }

    pub fn validate_replacement_epoch(&self, key_epoch: u64) -> Result<(), RecoveryError> {
        if key_epoch <= self.prior_key_epoch {
            return Err(RecoveryError::EpochMustAdvance);
        }
        Ok(())
    }
}

fn validate(device_key_id: &str, messages: &[ArchivedMessage]) -> Result<(), RecoveryError> {
    if device_key_id.is_empty() || device_key_id.len() > 1024 {
        return Err(RecoveryError::InvalidArchive);
    }
    if messages.len() > MAX_MESSAGES {
        return Err(RecoveryError::TooLarge);
    }
    for message in messages {
        if message.conversation_id.is_empty()
            || message.message_id.is_empty()
            || message.sender_key_id.is_empty()
            || message.conversation_id.len() > 1024
            || message.message_id.len() > 1024
            || message.sender_key_id.len() > 1024
            || message.plaintext.len() > MAX_FIELD_BYTES
        {
            return Err(RecoveryError::TooLarge);
        }
    }
    Ok(())
}

fn map_vault_error(error: VaultError) -> RecoveryError {
    match error {
        VaultError::AuthenticationFailed => RecoveryError::AuthenticationFailed,
        _ => RecoveryError::InvalidArchive,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message() -> ArchivedMessage {
        ArchivedMessage {
            conversation_id: "conversation-1".into(),
            message_id: "message-1".into(),
            sender_key_id: "device-old".into(),
            created_at_ms: 123,
            plaintext: b"historical message".to_vec(),
        }
    }

    #[test]
    fn recovery_is_read_only_and_requires_a_successor_device_epoch() {
        let sealed = ReadOnlyArchive::export(
            "device-old",
            7,
            vec![message()],
            b"high entropy recovery secret",
        )
        .unwrap();
        assert!(!sealed
            .windows(b"historical message".len())
            .any(|part| part == b"historical message"));

        let archive = ReadOnlyArchive::import(&sealed, b"high entropy recovery secret").unwrap();
        assert_eq!(archive.messages(), &[message()]);
        assert_eq!(
            archive.validate_replacement_epoch(7),
            Err(RecoveryError::EpochMustAdvance)
        );
        archive.validate_replacement_epoch(8).unwrap();
        assert_eq!(
            archive.replacement_requirement().revoked_device_key_id,
            "device-old"
        );
    }

    #[test]
    fn wrong_secret_and_tampering_do_not_expose_an_oracle() {
        let mut sealed =
            ReadOnlyArchive::export("device-old", 1, vec![message()], b"correct recovery secret")
                .unwrap();
        assert_eq!(
            ReadOnlyArchive::import(&sealed, b"wrong recovery secret"),
            Err(RecoveryError::AuthenticationFailed)
        );
        let last = sealed.len() - 1;
        sealed[last] ^= 1;
        assert_eq!(
            ReadOnlyArchive::import(&sealed, b"correct recovery secret"),
            Err(RecoveryError::AuthenticationFailed)
        );
    }
}
