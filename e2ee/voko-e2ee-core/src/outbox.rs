use std::collections::{hash_map::Entry, HashMap};

use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboxState {
    Prepared,
    Sent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxRecord {
    pub message_id: Vec<u8>,
    pub state_version: u64,
    pub ciphertext: Vec<u8>,
    pub ciphertext_digest: [u8; 32],
    pub state: OutboxState,
}

#[derive(Debug, Default)]
pub struct PreparedOutbox {
    records: HashMap<Vec<u8>, OutboxRecord>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum OutboxError {
    #[error("message id and ciphertext must not be empty")]
    Empty,
    #[error("message id already refers to different ciphertext or state")]
    Conflict,
    #[error("message id was not prepared")]
    NotFound,
}

impl PreparedOutbox {
    /// Models the host-side atomic write contract. A persistent host must write
    /// its serialized MLS state and this record in the same transaction before
    /// attempting network delivery.
    pub fn prepare(
        &mut self,
        message_id: &[u8],
        state_version: u64,
        ciphertext: &[u8],
    ) -> Result<&OutboxRecord, OutboxError> {
        if message_id.is_empty() || ciphertext.is_empty() {
            return Err(OutboxError::Empty);
        }
        let digest: [u8; 32] = Sha256::digest(ciphertext).into();
        match self.records.entry(message_id.to_vec()) {
            Entry::Occupied(entry) => {
                let existing = entry.into_mut();
                if existing.state_version != state_version || existing.ciphertext_digest != digest {
                    return Err(OutboxError::Conflict);
                }
                Ok(existing)
            }
            Entry::Vacant(entry) => Ok(entry.insert(OutboxRecord {
                message_id: message_id.to_vec(),
                state_version,
                ciphertext: ciphertext.to_vec(),
                ciphertext_digest: digest,
                state: OutboxState::Prepared,
            })),
        }
    }

    pub fn fixed_ciphertext(&self, message_id: &[u8]) -> Result<&[u8], OutboxError> {
        self.records
            .get(message_id)
            .map(|record| record.ciphertext.as_slice())
            .ok_or(OutboxError::NotFound)
    }

    pub fn mark_sent(&mut self, message_id: &[u8]) -> Result<(), OutboxError> {
        let record = self
            .records
            .get_mut(message_id)
            .ok_or(OutboxError::NotFound)?;
        record.state = OutboxState::Sent;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_reuses_fixed_ciphertext_and_conflicts_fail_closed() {
        let mut outbox = PreparedOutbox::default();
        outbox
            .prepare(b"message-1", 3, b"fixed-ciphertext")
            .unwrap();
        assert_eq!(
            outbox.fixed_ciphertext(b"message-1").unwrap(),
            b"fixed-ciphertext"
        );
        assert!(outbox.prepare(b"message-1", 3, b"fixed-ciphertext").is_ok());
        assert_eq!(
            outbox.prepare(b"message-1", 4, b"new-ciphertext"),
            Err(OutboxError::Conflict)
        );
    }
}
