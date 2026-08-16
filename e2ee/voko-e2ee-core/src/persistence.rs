use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredDelivery {
    pub message_id: String,
    pub group_id: String,
    pub state_version: u64,
    pub ciphertext: Vec<u8>,
    pub sent: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimedDelivery {
    pub delivery: StoredDelivery,
    pub lease_owner: String,
    pub lease_expires_at_ms: u64,
}

/// Latest state marker that must be sealed outside the SQLite file (for
/// example by the OS-backed Vault) to detect database rollback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateAnchor {
    pub group_id: String,
    pub state_version: u64,
    pub encrypted_state_digest: [u8; 32],
}

pub struct AtomicStateStore {
    connection: Connection,
}

#[derive(Debug, Error)]
pub enum PersistenceError {
    #[error("persistent E2EE store failed: {0}")]
    Database(String),
    #[error("invalid persistent E2EE input")]
    InvalidInput,
    #[error("MLS state version changed concurrently")]
    VersionConflict,
    #[error("message id already refers to different state or ciphertext")]
    MessageConflict,
    #[error("delivery lease is not owned by this worker")]
    LeaseConflict,
    #[error("numeric value is outside the supported range")]
    NumericRange,
    #[error("persistent MLS state is older than its external rollback anchor")]
    RollbackDetected,
}

impl From<rusqlite::Error> for PersistenceError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Database(value.to_string())
    }
}

impl AtomicStateStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, PersistenceError> {
        let connection = Connection::open(path)?;
        Self::initialize(connection)
    }

    pub fn in_memory() -> Result<Self, PersistenceError> {
        Self::initialize(Connection::open_in_memory()?)
    }

    fn initialize(connection: Connection) -> Result<Self, PersistenceError> {
        connection.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS e2ee_group_states (
               group_id TEXT PRIMARY KEY,
               state_version INTEGER NOT NULL,
               encrypted_state BLOB NOT NULL,
               state_digest BLOB NOT NULL
             );
             CREATE TABLE IF NOT EXISTS e2ee_outbox (
               message_id TEXT PRIMARY KEY,
               group_id TEXT NOT NULL,
               state_version INTEGER NOT NULL,
               ciphertext BLOB NOT NULL,
               ciphertext_digest BLOB NOT NULL,
               sent INTEGER NOT NULL DEFAULT 0,
               lease_owner TEXT,
               lease_expires_at_ms INTEGER,
               FOREIGN KEY(group_id) REFERENCES e2ee_group_states(group_id)
             );
             CREATE INDEX IF NOT EXISTS e2ee_outbox_pending
               ON e2ee_outbox(sent, lease_expires_at_ms);",
        )?;
        Ok(Self { connection })
    }

    /// Atomically advances an encrypted MLS state and persists the exact
    /// ciphertext that must be reused for every delivery retry.
    pub fn commit_prepared(
        &mut self,
        group_id: &str,
        expected_state_version: u64,
        encrypted_state: &[u8],
        message_id: &str,
        ciphertext: &[u8],
    ) -> Result<StoredDelivery, PersistenceError> {
        if group_id.is_empty()
            || message_id.is_empty()
            || encrypted_state.is_empty()
            || ciphertext.is_empty()
        {
            return Err(PersistenceError::InvalidInput);
        }
        let expected = to_i64(expected_state_version)?;
        let next = to_i64(
            expected_state_version
                .checked_add(1)
                .ok_or(PersistenceError::NumericRange)?,
        )?;
        let state_digest = Sha256::digest(encrypted_state).to_vec();
        let ciphertext_digest = Sha256::digest(ciphertext).to_vec();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;

        if let Some(existing) = load_delivery(&transaction, message_id)? {
            let stored_state_digest: Vec<u8> = transaction.query_row(
                "SELECT state_digest FROM e2ee_group_states WHERE group_id=?1",
                params![group_id],
                |row| row.get(0),
            )?;
            if existing.group_id == group_id
                && existing.state_version == expected_state_version + 1
                && Sha256::digest(&existing.ciphertext).as_slice() == ciphertext_digest
                && stored_state_digest == state_digest
            {
                transaction.commit()?;
                return Ok(existing);
            }
            return Err(PersistenceError::MessageConflict);
        }

        let current: Option<i64> = transaction
            .query_row(
                "SELECT state_version FROM e2ee_group_states WHERE group_id=?1",
                params![group_id],
                |row| row.get(0),
            )
            .optional()?;
        match current {
            None if expected != 0 => return Err(PersistenceError::VersionConflict),
            Some(version) if version != expected => return Err(PersistenceError::VersionConflict),
            None => {
                transaction.execute(
                    "INSERT INTO e2ee_group_states(group_id,state_version,encrypted_state,state_digest)
                     VALUES(?1,?2,?3,?4)",
                    params![group_id, next, encrypted_state, state_digest],
                )?;
            }
            Some(_) => {
                let changed = transaction.execute(
                    "UPDATE e2ee_group_states SET state_version=?1,encrypted_state=?2,state_digest=?3
                     WHERE group_id=?4 AND state_version=?5",
                    params![next, encrypted_state, state_digest, group_id, expected],
                )?;
                if changed != 1 {
                    return Err(PersistenceError::VersionConflict);
                }
            }
        }
        transaction.execute(
            "INSERT INTO e2ee_outbox(message_id,group_id,state_version,ciphertext,ciphertext_digest)
             VALUES(?1,?2,?3,?4,?5)",
            params![message_id, group_id, next, ciphertext, ciphertext_digest],
        )?;
        let delivery = load_delivery(&transaction, message_id)?
            .ok_or_else(|| PersistenceError::Database("prepared delivery disappeared".into()))?;
        transaction.commit()?;
        Ok(delivery)
    }

    pub fn encrypted_group_state(
        &self,
        group_id: &str,
    ) -> Result<Option<(u64, Vec<u8>)>, PersistenceError> {
        self.connection
            .query_row(
                "SELECT state_version,encrypted_state,state_digest FROM e2ee_group_states WHERE group_id=?1",
                params![group_id],
                |row| {
                    let version: i64 = row.get(0)?;
                    let state: Vec<u8> = row.get(1)?;
                    let digest: Vec<u8> = row.get(2)?;
                    Ok((version, state, digest))
                },
            )
            .optional()?
            .map(|(version, state, digest)| {
                if Sha256::digest(&state).as_slice() != digest {
                    return Err(PersistenceError::Database("encrypted state digest mismatch".into()));
                }
                Ok((from_i64(version)?, state))
            })
            .transpose()
    }

    pub fn state_anchor(&self, group_id: &str) -> Result<Option<StateAnchor>, PersistenceError> {
        self.connection
            .query_row(
                "SELECT state_version,state_digest FROM e2ee_group_states WHERE group_id=?1",
                params![group_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?)),
            )
            .optional()?
            .map(|(version, digest)| {
                let digest: [u8; 32] = digest.try_into().map_err(|_| {
                    PersistenceError::Database("invalid state digest length".into())
                })?;
                Ok(StateAnchor {
                    group_id: group_id.to_owned(),
                    state_version: from_i64(version)?,
                    encrypted_state_digest: digest,
                })
            })
            .transpose()
    }

    pub fn verify_external_anchor(&self, anchor: &StateAnchor) -> Result<(), PersistenceError> {
        let current = self
            .state_anchor(&anchor.group_id)?
            .ok_or(PersistenceError::RollbackDetected)?;
        if current.state_version < anchor.state_version
            || (current.state_version == anchor.state_version
                && current.encrypted_state_digest != anchor.encrypted_state_digest)
        {
            return Err(PersistenceError::RollbackDetected);
        }
        Ok(())
    }

    pub fn claim_next(
        &mut self,
        lease_owner: &str,
        now_ms: u64,
        lease_duration_ms: u64,
    ) -> Result<Option<ClaimedDelivery>, PersistenceError> {
        if lease_owner.is_empty() || lease_duration_ms == 0 {
            return Err(PersistenceError::InvalidInput);
        }
        let now = to_i64(now_ms)?;
        let expires = to_i64(
            now_ms
                .checked_add(lease_duration_ms)
                .ok_or(PersistenceError::NumericRange)?,
        )?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let message_id: Option<String> = transaction
            .query_row(
                "SELECT message_id FROM e2ee_outbox
                 WHERE sent=0 AND (lease_owner IS NULL OR lease_expires_at_ms<=?1)
                 ORDER BY rowid LIMIT 1",
                params![now],
                |row| row.get(0),
            )
            .optional()?;
        let Some(message_id) = message_id else {
            transaction.commit()?;
            return Ok(None);
        };
        let changed = transaction.execute(
            "UPDATE e2ee_outbox SET lease_owner=?1,lease_expires_at_ms=?2
             WHERE message_id=?3 AND sent=0 AND (lease_owner IS NULL OR lease_expires_at_ms<=?4)",
            params![lease_owner, expires, message_id, now],
        )?;
        if changed != 1 {
            return Err(PersistenceError::LeaseConflict);
        }
        let delivery = load_delivery(&transaction, &message_id)?
            .ok_or_else(|| PersistenceError::Database("claimed delivery disappeared".into()))?;
        transaction.commit()?;
        Ok(Some(ClaimedDelivery {
            delivery,
            lease_owner: lease_owner.to_owned(),
            lease_expires_at_ms: now_ms + lease_duration_ms,
        }))
    }

    pub fn mark_sent(
        &mut self,
        message_id: &str,
        lease_owner: &str,
    ) -> Result<(), PersistenceError> {
        let changed = self.connection.execute(
            "UPDATE e2ee_outbox SET sent=1,lease_owner=NULL,lease_expires_at_ms=NULL
             WHERE message_id=?1 AND sent=0 AND lease_owner=?2",
            params![message_id, lease_owner],
        )?;
        if changed != 1 {
            return Err(PersistenceError::LeaseConflict);
        }
        Ok(())
    }
}

fn load_delivery(
    connection: &Connection,
    message_id: &str,
) -> Result<Option<StoredDelivery>, PersistenceError> {
    connection
        .query_row(
            "SELECT message_id,group_id,state_version,ciphertext,ciphertext_digest,sent
             FROM e2ee_outbox WHERE message_id=?1",
            params![message_id],
            |row| {
                let version: i64 = row.get(2)?;
                let sent: i64 = row.get(5)?;
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    version,
                    row.get::<_, Vec<u8>>(3)?,
                    row.get::<_, Vec<u8>>(4)?,
                    sent,
                ))
            },
        )
        .optional()?
        .map(
            |(message_id, group_id, version, ciphertext, digest, sent)| {
                if Sha256::digest(&ciphertext).as_slice() != digest {
                    return Err(PersistenceError::Database(
                        "ciphertext digest mismatch".into(),
                    ));
                }
                Ok(StoredDelivery {
                    message_id,
                    group_id,
                    state_version: from_i64(version)?,
                    ciphertext,
                    sent: sent != 0,
                })
            },
        )
        .transpose()
}

fn to_i64(value: u64) -> Result<i64, PersistenceError> {
    i64::try_from(value).map_err(|_| PersistenceError::NumericRange)
}

fn from_i64(value: i64) -> Result<u64, PersistenceError> {
    u64::try_from(value).map_err(|_| PersistenceError::NumericRange)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_and_fixed_ciphertext_commit_atomically() {
        let mut store = AtomicStateStore::in_memory().unwrap();
        let delivery = store
            .commit_prepared(
                "group-1",
                0,
                b"encrypted-state-1",
                "message-1",
                b"ciphertext-1",
            )
            .unwrap();
        assert_eq!(delivery.state_version, 1);
        assert_eq!(
            store.encrypted_group_state("group-1").unwrap().unwrap(),
            (1, b"encrypted-state-1".to_vec())
        );
        assert_eq!(
            store
                .commit_prepared(
                    "group-1",
                    0,
                    b"encrypted-state-1",
                    "message-1",
                    b"ciphertext-1"
                )
                .unwrap(),
            delivery
        );
        assert!(matches!(
            store.commit_prepared("group-1", 0, b"state-2", "message-2", b"ciphertext-2"),
            Err(PersistenceError::VersionConflict)
        ));
    }

    #[test]
    fn expired_lease_retries_the_identical_ciphertext_after_restart() {
        let path = std::env::temp_dir().join(format!(
            "voko-e2ee-store-{}-{}.db",
            std::process::id(),
            rand::random::<u64>()
        ));
        {
            let mut store = AtomicStateStore::open(&path).unwrap();
            store
                .commit_prepared(
                    "group-2",
                    0,
                    b"encrypted-state",
                    "message-2",
                    b"fixed-ciphertext",
                )
                .unwrap();
            let first = store.claim_next("worker-a", 1000, 100).unwrap().unwrap();
            assert_eq!(first.delivery.ciphertext, b"fixed-ciphertext");
            assert!(store.claim_next("worker-b", 1050, 100).unwrap().is_none());
        }
        {
            let mut store = AtomicStateStore::open(&path).unwrap();
            let recovered = store.claim_next("worker-b", 1100, 100).unwrap().unwrap();
            assert_eq!(recovered.delivery.ciphertext, b"fixed-ciphertext");
            assert!(matches!(
                store.mark_sent("message-2", "worker-a"),
                Err(PersistenceError::LeaseConflict)
            ));
            store.mark_sent("message-2", "worker-b").unwrap();
            assert!(store.claim_next("worker-c", 1300, 100).unwrap().is_none());
        }
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn external_anchor_detects_missing_or_replaced_state() {
        let mut store = AtomicStateStore::in_memory().unwrap();
        store
            .commit_prepared(
                "group-anchor",
                0,
                b"sealed-state",
                "message-anchor",
                b"ciphertext",
            )
            .unwrap();
        let anchor = store.state_anchor("group-anchor").unwrap().unwrap();
        store.verify_external_anchor(&anchor).unwrap();

        let mut replaced = anchor.clone();
        replaced.encrypted_state_digest[0] ^= 1;
        assert!(matches!(
            store.verify_external_anchor(&replaced),
            Err(PersistenceError::RollbackDetected)
        ));
        let missing = StateAnchor {
            group_id: "missing".into(),
            ..anchor
        };
        assert!(matches!(
            store.verify_external_anchor(&missing),
            Err(PersistenceError::RollbackDetected)
        ));
    }
}
