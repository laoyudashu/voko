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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimedReceived {
    pub message_id: String,
    pub encrypted_payload: Vec<u8>,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyPackageBinding {
    pub target_agent_did: String,
    pub owner_device_key_id: String,
    pub key_epoch: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinStatus {
    PinnedNew,
    Verified,
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
    #[error("KeyPackage is not registered")]
    KeyPackageNotRegistered,
    #[error("KeyPackage is expired")]
    KeyPackageExpired,
    #[error("KeyPackage identity binding does not match")]
    KeyPackageBindingMismatch,
    #[error("KeyPackage was already consumed by another group")]
    KeyPackageReuse,
    #[error("credential identity changed and requires explicit verification")]
    IdentityChanged,
    #[error("credential epoch rolled back")]
    CredentialRollback,
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
               ON e2ee_outbox(sent, lease_expires_at_ms);
             CREATE TABLE IF NOT EXISTS e2ee_inbox (
               message_id TEXT PRIMARY KEY,
               group_id TEXT NOT NULL,
               state_version INTEGER NOT NULL,
               encrypted_payload BLOB NOT NULL,
               payload_digest BLOB NOT NULL,
               dispatched INTEGER NOT NULL DEFAULT 0,
               lease_owner TEXT,
               lease_expires_at_ms INTEGER,
               FOREIGN KEY(group_id) REFERENCES e2ee_group_states(group_id)
             );
             CREATE INDEX IF NOT EXISTS e2ee_inbox_pending
               ON e2ee_inbox(dispatched, lease_expires_at_ms);
             CREATE TABLE IF NOT EXISTS e2ee_key_packages (
               key_package_ref BLOB PRIMARY KEY,
               target_agent_did TEXT NOT NULL,
               owner_device_key_id TEXT NOT NULL,
               key_epoch INTEGER NOT NULL,
               expires_at_ms INTEGER NOT NULL,
               consumed_group_id TEXT,
               consumed_at_ms INTEGER
             );
             CREATE TABLE IF NOT EXISTS e2ee_credential_pins (
               identity_scope TEXT NOT NULL,
               role INTEGER NOT NULL,
               device_key_id TEXT NOT NULL,
               key_epoch INTEGER NOT NULL,
               credential_fingerprint BLOB NOT NULL,
               PRIMARY KEY(identity_scope, role)
             );",
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

    pub fn has_received(&self, message_id: &str) -> Result<bool, PersistenceError> {
        Ok(self
            .connection
            .query_row(
                "SELECT 1 FROM e2ee_inbox WHERE message_id=?1",
                params![message_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// Atomically records the post-decryption MLS state and a locally encrypted
    /// payload. Provider dispatch must happen only after this commit succeeds.
    pub fn commit_received(
        &mut self,
        group_id: &str,
        expected_state_version: u64,
        encrypted_state: &[u8],
        message_id: &str,
        encrypted_payload: &[u8],
    ) -> Result<bool, PersistenceError> {
        if group_id.is_empty()
            || message_id.is_empty()
            || encrypted_state.is_empty()
            || encrypted_payload.is_empty()
        {
            return Err(PersistenceError::InvalidInput);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<(String, Vec<u8>)> = transaction
            .query_row(
                "SELECT group_id,payload_digest FROM e2ee_inbox WHERE message_id=?1",
                params![message_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let payload_digest = Sha256::digest(encrypted_payload).to_vec();
        if let Some((existing_group, existing_digest)) = existing {
            if existing_group == group_id && existing_digest == payload_digest {
                transaction.commit()?;
                return Ok(false);
            }
            return Err(PersistenceError::MessageConflict);
        }

        let expected = to_i64(expected_state_version)?;
        let next_version = expected_state_version
            .checked_add(1)
            .ok_or(PersistenceError::NumericRange)?;
        let next = to_i64(next_version)?;
        let state_digest = Sha256::digest(encrypted_state).to_vec();
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
                if transaction.execute(
                    "UPDATE e2ee_group_states SET state_version=?1,encrypted_state=?2,state_digest=?3
                     WHERE group_id=?4 AND state_version=?5",
                    params![next, encrypted_state, state_digest, group_id, expected],
                )? != 1
                {
                    return Err(PersistenceError::VersionConflict);
                }
            }
        }
        transaction.execute(
            "INSERT INTO e2ee_inbox(message_id,group_id,state_version,encrypted_payload,payload_digest)
             VALUES(?1,?2,?3,?4,?5)",
            params![message_id, group_id, next, encrypted_payload, payload_digest],
        )?;
        transaction.commit()?;
        Ok(true)
    }

    pub fn pending_received_count(&self) -> Result<u64, PersistenceError> {
        let count: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM e2ee_inbox WHERE dispatched=0",
            [],
            |row| row.get(0),
        )?;
        from_i64(count)
    }

    pub fn claim_next_received(
        &mut self,
        lease_owner: &str,
        now_ms: u64,
        lease_duration_ms: u64,
    ) -> Result<Option<ClaimedReceived>, PersistenceError> {
        if lease_owner.is_empty() || lease_duration_ms == 0 {
            return Err(PersistenceError::InvalidInput);
        }
        let now = to_i64(now_ms)?;
        let expires_at = now_ms
            .checked_add(lease_duration_ms)
            .ok_or(PersistenceError::NumericRange)?;
        let expires = to_i64(expires_at)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let candidate: Option<(String, Vec<u8>)> = transaction
            .query_row(
                "SELECT message_id,encrypted_payload FROM e2ee_inbox
                 WHERE dispatched=0 AND (lease_owner IS NULL OR lease_expires_at_ms<=?1)
                 ORDER BY rowid LIMIT 1",
                params![now],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((message_id, encrypted_payload)) = candidate else {
            transaction.commit()?;
            return Ok(None);
        };
        if transaction.execute(
            "UPDATE e2ee_inbox SET lease_owner=?1,lease_expires_at_ms=?2
             WHERE message_id=?3 AND dispatched=0
               AND (lease_owner IS NULL OR lease_expires_at_ms<=?4)",
            params![lease_owner, expires, message_id, now],
        )? != 1
        {
            return Err(PersistenceError::LeaseConflict);
        }
        transaction.commit()?;
        Ok(Some(ClaimedReceived {
            message_id,
            encrypted_payload,
            lease_owner: lease_owner.to_owned(),
            lease_expires_at_ms: expires_at,
        }))
    }

    pub fn mark_received_dispatched(
        &mut self,
        message_id: &str,
        lease_owner: &str,
    ) -> Result<(), PersistenceError> {
        if self.connection.execute(
            "UPDATE e2ee_inbox
             SET dispatched=1,lease_owner=NULL,lease_expires_at_ms=NULL
             WHERE message_id=?1 AND dispatched=0 AND lease_owner=?2",
            params![message_id, lease_owner],
        )? != 1
        {
            return Err(PersistenceError::LeaseConflict);
        }
        Ok(())
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

    pub fn register_key_package(
        &mut self,
        serialized_key_package: &[u8],
        binding: &KeyPackageBinding,
        now_ms: u64,
        expires_at_ms: u64,
    ) -> Result<[u8; 32], PersistenceError> {
        const MAX_KEY_PACKAGE_LIFETIME_MS: u64 = 24 * 60 * 60 * 1000;
        validate_key_package_binding(binding)?;
        if serialized_key_package.is_empty()
            || expires_at_ms <= now_ms
            || expires_at_ms - now_ms > MAX_KEY_PACKAGE_LIFETIME_MS
        {
            return Err(PersistenceError::InvalidInput);
        }
        let reference: [u8; 32] = Sha256::digest(serialized_key_package).into();
        let key_epoch = to_i64(binding.key_epoch)?;
        let expires = to_i64(expires_at_ms)?;
        let changed = self.connection.execute(
            "INSERT OR IGNORE INTO e2ee_key_packages(
               key_package_ref,target_agent_did,owner_device_key_id,key_epoch,expires_at_ms
             ) VALUES(?1,?2,?3,?4,?5)",
            params![
                reference.as_slice(),
                binding.target_agent_did,
                binding.owner_device_key_id,
                key_epoch,
                expires
            ],
        )?;
        if changed == 0 {
            let existing: (String, String, i64, i64) = self.connection.query_row(
                "SELECT target_agent_did,owner_device_key_id,key_epoch,expires_at_ms
                 FROM e2ee_key_packages WHERE key_package_ref=?1",
                params![reference.as_slice()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            if existing
                != (
                    binding.target_agent_did.clone(),
                    binding.owner_device_key_id.clone(),
                    key_epoch,
                    expires,
                )
            {
                return Err(PersistenceError::KeyPackageBindingMismatch);
            }
        }
        Ok(reference)
    }

    pub fn consume_key_package(
        &mut self,
        serialized_key_package: &[u8],
        group_id: &str,
        binding: &KeyPackageBinding,
        now_ms: u64,
    ) -> Result<[u8; 32], PersistenceError> {
        validate_key_package_binding(binding)?;
        if serialized_key_package.is_empty() || group_id.is_empty() {
            return Err(PersistenceError::InvalidInput);
        }
        let reference: [u8; 32] = Sha256::digest(serialized_key_package).into();
        let now = to_i64(now_ms)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let record: Option<(String, String, i64, i64, Option<String>)> = transaction
            .query_row(
                "SELECT target_agent_did,owner_device_key_id,key_epoch,expires_at_ms,consumed_group_id
                 FROM e2ee_key_packages WHERE key_package_ref=?1",
                params![reference.as_slice()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .optional()?;
        let Some((agent, device, epoch, expires, consumed_group)) = record else {
            return Err(PersistenceError::KeyPackageNotRegistered);
        };
        if agent != binding.target_agent_did
            || device != binding.owner_device_key_id
            || from_i64(epoch)? != binding.key_epoch
        {
            return Err(PersistenceError::KeyPackageBindingMismatch);
        }
        if expires <= now {
            return Err(PersistenceError::KeyPackageExpired);
        }
        if let Some(consumed_group) = consumed_group {
            if consumed_group == group_id {
                transaction.commit()?;
                return Ok(reference);
            }
            return Err(PersistenceError::KeyPackageReuse);
        }
        if transaction.execute(
            "UPDATE e2ee_key_packages SET consumed_group_id=?1,consumed_at_ms=?2
             WHERE key_package_ref=?3 AND consumed_group_id IS NULL",
            params![group_id, now, reference.as_slice()],
        )? != 1
        {
            return Err(PersistenceError::KeyPackageReuse);
        }
        transaction.commit()?;
        Ok(reference)
    }

    pub fn pin_or_verify_credential(
        &mut self,
        identity_scope: &str,
        role: u8,
        device_key_id: &str,
        key_epoch: u64,
        credential_public_key: &[u8],
    ) -> Result<PinStatus, PersistenceError> {
        validate_credential_pin(identity_scope, role, device_key_id, credential_public_key)?;
        let epoch = to_i64(key_epoch)?;
        let fingerprint = Sha256::digest(credential_public_key).to_vec();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<(String, i64, Vec<u8>)> = transaction
            .query_row(
                "SELECT device_key_id,key_epoch,credential_fingerprint
                 FROM e2ee_credential_pins WHERE identity_scope=?1 AND role=?2",
                params![identity_scope, role,],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        match existing {
            None => {
                transaction.execute(
                    "INSERT INTO e2ee_credential_pins(
                       identity_scope,role,device_key_id,key_epoch,credential_fingerprint
                     ) VALUES(?1,?2,?3,?4,?5)",
                    params![identity_scope, role, device_key_id, epoch, fingerprint],
                )?;
                transaction.commit()?;
                Ok(PinStatus::PinnedNew)
            }
            Some((pinned_device, pinned_epoch, pinned_fingerprint)) => {
                if epoch < pinned_epoch {
                    return Err(PersistenceError::CredentialRollback);
                }
                if pinned_device != device_key_id
                    || pinned_epoch != epoch
                    || pinned_fingerprint != fingerprint
                {
                    return Err(PersistenceError::IdentityChanged);
                }
                transaction.commit()?;
                Ok(PinStatus::Verified)
            }
        }
    }

    pub fn approve_credential_successor(
        &mut self,
        identity_scope: &str,
        role: u8,
        expected_current_fingerprint: &[u8; 32],
        new_device_key_id: &str,
        new_key_epoch: u64,
        new_credential_public_key: &[u8],
    ) -> Result<(), PersistenceError> {
        validate_credential_pin(
            identity_scope,
            role,
            new_device_key_id,
            new_credential_public_key,
        )?;
        let new_epoch = to_i64(new_key_epoch)?;
        let new_fingerprint = Sha256::digest(new_credential_public_key).to_vec();
        let changed = self.connection.execute(
            "UPDATE e2ee_credential_pins
             SET device_key_id=?1,key_epoch=?2,credential_fingerprint=?3
             WHERE identity_scope=?4 AND role=?5 AND key_epoch<?2
               AND credential_fingerprint=?6",
            params![
                new_device_key_id,
                new_epoch,
                new_fingerprint,
                identity_scope,
                role,
                expected_current_fingerprint.as_slice()
            ],
        )?;
        if changed != 1 {
            return Err(PersistenceError::IdentityChanged);
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

fn validate_key_package_binding(binding: &KeyPackageBinding) -> Result<(), PersistenceError> {
    if binding.target_agent_did.is_empty()
        || binding.owner_device_key_id.is_empty()
        || binding.target_agent_did.len() > 1024
        || binding.owner_device_key_id.len() > 1024
        || binding.target_agent_did.chars().any(char::is_control)
        || binding.owner_device_key_id.chars().any(char::is_control)
    {
        return Err(PersistenceError::InvalidInput);
    }
    Ok(())
}

fn validate_credential_pin(
    identity_scope: &str,
    role: u8,
    device_key_id: &str,
    credential_public_key: &[u8],
) -> Result<(), PersistenceError> {
    if identity_scope.is_empty()
        || identity_scope.len() > 1024
        || identity_scope.chars().any(char::is_control)
        || role == 0
        || device_key_id.is_empty()
        || device_key_id.len() > 1024
        || device_key_id.chars().any(char::is_control)
        || credential_public_key.is_empty()
        || credential_public_key.len() > 4096
    {
        return Err(PersistenceError::InvalidInput);
    }
    Ok(())
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

    #[test]
    fn received_state_and_local_payload_are_committed_once() {
        let mut store = AtomicStateStore::in_memory().unwrap();
        assert!(store
            .commit_received(
                "group-in",
                0,
                b"sealed-state-1",
                "message-in",
                b"sealed-payload"
            )
            .unwrap());
        assert!(store.has_received("message-in").unwrap());
        assert!(!store
            .commit_received(
                "group-in",
                0,
                b"ignored-on-dedup",
                "message-in",
                b"sealed-payload"
            )
            .unwrap());
        assert_eq!(store.pending_received_count().unwrap(), 1);
        let claimed = store
            .claim_next_received("provider-worker", 100, 10)
            .unwrap()
            .unwrap();
        assert_eq!(claimed.message_id, "message-in");
        assert!(store
            .claim_next_received("other-worker", 105, 10)
            .unwrap()
            .is_none());
        assert!(matches!(
            store.mark_received_dispatched("message-in", "other-worker"),
            Err(PersistenceError::LeaseConflict)
        ));
        store
            .mark_received_dispatched("message-in", "provider-worker")
            .unwrap();
        assert_eq!(store.pending_received_count().unwrap(), 0);
    }

    #[test]
    fn persistent_key_package_is_short_lived_bound_and_single_use() {
        let mut store = AtomicStateStore::in_memory().unwrap();
        let binding = KeyPackageBinding {
            target_agent_did: "did:voko:agent-key-package".into(),
            owner_device_key_id: "owner-device-key-package".into(),
            key_epoch: 7,
        };
        store
            .register_key_package(b"serialized-key-package", &binding, 1_000, 2_000)
            .unwrap();
        assert!(matches!(
            store.consume_key_package(
                b"serialized-key-package",
                "group-a",
                &KeyPackageBinding {
                    key_epoch: 8,
                    ..binding.clone()
                },
                1_100
            ),
            Err(PersistenceError::KeyPackageBindingMismatch)
        ));
        store
            .consume_key_package(b"serialized-key-package", "group-a", &binding, 1_100)
            .unwrap();
        store
            .consume_key_package(b"serialized-key-package", "group-a", &binding, 1_200)
            .unwrap();
        assert!(matches!(
            store.consume_key_package(b"serialized-key-package", "group-b", &binding, 1_200),
            Err(PersistenceError::KeyPackageReuse)
        ));

        store
            .register_key_package(b"expired-key-package", &binding, 1_000, 1_001)
            .unwrap();
        assert!(matches!(
            store.consume_key_package(b"expired-key-package", "group-expired", &binding, 1_001),
            Err(PersistenceError::KeyPackageExpired)
        ));
        assert!(matches!(
            store.register_key_package(b"too-long-lived", &binding, 0, 24 * 60 * 60 * 1000 + 1),
            Err(PersistenceError::InvalidInput)
        ));
    }

    #[test]
    fn credential_change_fails_closed_until_successor_is_explicitly_approved() {
        let mut store = AtomicStateStore::in_memory().unwrap();
        assert_eq!(
            store
                .pin_or_verify_credential("owner-device-scope", 2, "device-a", 4, b"public-key-a")
                .unwrap(),
            PinStatus::PinnedNew
        );
        assert_eq!(
            store
                .pin_or_verify_credential("owner-device-scope", 2, "device-a", 4, b"public-key-a")
                .unwrap(),
            PinStatus::Verified
        );
        assert!(matches!(
            store.pin_or_verify_credential("owner-device-scope", 2, "device-b", 5, b"public-key-b"),
            Err(PersistenceError::IdentityChanged)
        ));
        assert!(matches!(
            store.pin_or_verify_credential("owner-device-scope", 2, "device-a", 3, b"public-key-a"),
            Err(PersistenceError::CredentialRollback)
        ));
        let old_fingerprint: [u8; 32] = Sha256::digest(b"public-key-a").into();
        store
            .approve_credential_successor(
                "owner-device-scope",
                2,
                &old_fingerprint,
                "device-b",
                5,
                b"public-key-b",
            )
            .unwrap();
        assert_eq!(
            store
                .pin_or_verify_credential("owner-device-scope", 2, "device-b", 5, b"public-key-b")
                .unwrap(),
            PinStatus::Verified
        );
    }
}
