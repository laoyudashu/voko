use keyring::{Entry, Error as KeyringError};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

use crate::{RecordVault, StateAnchor};

const SERVICE: &str = "com.vokovoko.e2ee.vault";

pub trait WrappingKeyStore {
    fn load(&self, slot: &str) -> Result<Option<Zeroizing<Vec<u8>>>, VaultKeyError>;
    fn store(&self, slot: &str, secret: &[u8]) -> Result<(), VaultKeyError>;
    fn delete(&self, slot: &str) -> Result<(), VaultKeyError>;
}

pub struct SystemWrappingKeyStore;

impl SystemWrappingKeyStore {
    pub fn is_available() -> bool {
        Entry::store_status().is_ok()
    }

    fn entry(slot: &str) -> Result<Entry, VaultKeyError> {
        Entry::new(SERVICE, slot).map_err(map_keyring_error)
    }
}

impl WrappingKeyStore for SystemWrappingKeyStore {
    fn load(&self, slot: &str) -> Result<Option<Zeroizing<Vec<u8>>>, VaultKeyError> {
        match Self::entry(slot)?.get_secret() {
            Ok(secret) => Ok(Some(Zeroizing::new(secret))),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(error) => Err(map_keyring_error(error)),
        }
    }

    fn store(&self, slot: &str, secret: &[u8]) -> Result<(), VaultKeyError> {
        Self::entry(slot)?
            .set_secret(secret)
            .map_err(map_keyring_error)
    }

    fn delete(&self, slot: &str) -> Result<(), VaultKeyError> {
        match Self::entry(slot)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(map_keyring_error(error)),
        }
    }
}

pub struct VaultKeyManager<S> {
    store: S,
}

impl<S: WrappingKeyStore> VaultKeyManager<S> {
    pub fn new(store: S) -> Self {
        Self { store }
    }

    pub fn provision(&self, owner_scope: &[u8]) -> Result<RecordVault, VaultKeyError> {
        let slot = slot_id(b"master-key", owner_scope)?;
        if self.store.load(&slot)?.is_some() {
            return Err(VaultKeyError::AlreadyProvisioned);
        }
        let mut key = Zeroizing::new([0u8; 32]);
        OsRng.fill_bytes(key.as_mut());
        self.store.store(&slot, key.as_ref())?;
        let persisted = self.store.load(&slot)?.ok_or(VaultKeyError::Unavailable)?;
        if persisted.as_slice() != key.as_ref() {
            let _ = self.store.delete(&slot);
            return Err(VaultKeyError::VerificationFailed);
        }
        RecordVault::from_master_key(key.as_ref()).map_err(|_| VaultKeyError::CorruptKey)
    }

    pub fn unlock(&self, owner_scope: &[u8]) -> Result<RecordVault, VaultKeyError> {
        let key = self
            .store
            .load(&slot_id(b"master-key", owner_scope)?)?
            .ok_or(VaultKeyError::NotProvisioned)?;
        RecordVault::from_master_key(&key).map_err(|_| VaultKeyError::CorruptKey)
    }

    pub fn revoke(&self, owner_scope: &[u8]) -> Result<(), VaultKeyError> {
        self.store.delete(&slot_id(b"master-key", owner_scope)?)
    }
}

pub struct RollbackAnchorManager<S> {
    store: S,
}

impl<S: WrappingKeyStore> RollbackAnchorManager<S> {
    pub fn new(store: S) -> Self {
        Self { store }
    }

    pub fn load(
        &self,
        owner_scope: &[u8],
        group_id: &str,
    ) -> Result<Option<StateAnchor>, VaultKeyError> {
        if group_id.is_empty() {
            return Err(VaultKeyError::InvalidScope);
        }
        self.store
            .load(&anchor_slot(owner_scope, group_id)?)?
            .map(|bytes| decode_anchor(group_id, &bytes))
            .transpose()
    }

    pub fn advance(&self, owner_scope: &[u8], anchor: &StateAnchor) -> Result<(), VaultKeyError> {
        if let Some(current) = self.load(owner_scope, &anchor.group_id)? {
            if anchor.state_version < current.state_version
                || (anchor.state_version == current.state_version
                    && anchor.encrypted_state_digest != current.encrypted_state_digest)
            {
                return Err(VaultKeyError::RollbackDetected);
            }
            if anchor == &current {
                return Ok(());
            }
        }
        let slot = anchor_slot(owner_scope, &anchor.group_id)?;
        let encoded = encode_anchor(anchor);
        self.store.store(&slot, &encoded)?;
        let persisted = self
            .load(owner_scope, &anchor.group_id)?
            .ok_or(VaultKeyError::VerificationFailed)?;
        if persisted != *anchor {
            let _ = self.store.delete(&slot);
            return Err(VaultKeyError::VerificationFailed);
        }
        Ok(())
    }

    pub fn delete(&self, owner_scope: &[u8], group_id: &str) -> Result<(), VaultKeyError> {
        self.store.delete(&anchor_slot(owner_scope, group_id)?)
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum VaultKeyError {
    #[error("owner scope must not be empty")]
    InvalidScope,
    #[error("system credential store is unavailable")]
    Unavailable,
    #[error("Vault key is not provisioned")]
    NotProvisioned,
    #[error("Vault key is already provisioned")]
    AlreadyProvisioned,
    #[error("persisted Vault key verification failed")]
    VerificationFailed,
    #[error("persisted Vault key is corrupt")]
    CorruptKey,
    #[error("external MLS state anchor detected a rollback")]
    RollbackDetected,
}

fn slot_id(domain: &[u8], owner_scope: &[u8]) -> Result<String, VaultKeyError> {
    if owner_scope.is_empty() {
        return Err(VaultKeyError::InvalidScope);
    }
    let mut hasher = Sha256::new();
    hasher.update(b"voko-e2ee-system-slot/1");
    hasher.update((domain.len() as u64).to_be_bytes());
    hasher.update(domain);
    hasher.update((owner_scope.len() as u64).to_be_bytes());
    hasher.update(owner_scope);
    let mut digest = hasher.finalize().to_vec();
    let slot = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    digest.zeroize();
    Ok(slot)
}

fn anchor_slot(owner_scope: &[u8], group_id: &str) -> Result<String, VaultKeyError> {
    if group_id.is_empty() {
        return Err(VaultKeyError::InvalidScope);
    }
    let mut scope = Vec::with_capacity(owner_scope.len() + group_id.len() + 8);
    scope.extend_from_slice(&(owner_scope.len() as u64).to_be_bytes());
    scope.extend_from_slice(owner_scope);
    scope.extend_from_slice(group_id.as_bytes());
    let slot = slot_id(b"rollback-anchor", &scope);
    scope.zeroize();
    slot
}

fn encode_anchor(anchor: &StateAnchor) -> [u8; 40] {
    let mut output = [0u8; 40];
    output[..8].copy_from_slice(&anchor.state_version.to_be_bytes());
    output[8..].copy_from_slice(&anchor.encrypted_state_digest);
    output
}

fn decode_anchor(group_id: &str, input: &[u8]) -> Result<StateAnchor, VaultKeyError> {
    if input.len() != 40 {
        return Err(VaultKeyError::CorruptKey);
    }
    let version = u64::from_be_bytes(
        input[..8]
            .try_into()
            .map_err(|_| VaultKeyError::CorruptKey)?,
    );
    let digest = input[8..]
        .try_into()
        .map_err(|_| VaultKeyError::CorruptKey)?;
    Ok(StateAnchor {
        group_id: group_id.to_owned(),
        state_version: version,
        encrypted_state_digest: digest,
    })
}

fn map_keyring_error(_error: KeyringError) -> VaultKeyError {
    // Keyring details may contain platform paths or account metadata and are
    // deliberately not propagated to normal logs.
    VaultKeyError::Unavailable
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Mutex};

    use super::*;

    #[derive(Default)]
    struct MemoryStore(Mutex<HashMap<String, Vec<u8>>>);

    impl WrappingKeyStore for MemoryStore {
        fn load(&self, slot: &str) -> Result<Option<Zeroizing<Vec<u8>>>, VaultKeyError> {
            Ok(self
                .0
                .lock()
                .unwrap()
                .get(slot)
                .cloned()
                .map(Zeroizing::new))
        }

        fn store(&self, slot: &str, secret: &[u8]) -> Result<(), VaultKeyError> {
            self.0.lock().unwrap().insert(slot.into(), secret.to_vec());
            Ok(())
        }

        fn delete(&self, slot: &str) -> Result<(), VaultKeyError> {
            self.0.lock().unwrap().remove(slot);
            Ok(())
        }
    }

    #[test]
    fn owner_scopes_are_isolated_and_revocation_fails_closed() {
        let manager = VaultKeyManager::new(MemoryStore::default());
        let owner_a = manager.provision(b"owner-a").unwrap();
        let ciphertext = owner_a.seal(b"record", b"secret").unwrap();
        assert!(matches!(
            manager.provision(b"owner-a"),
            Err(VaultKeyError::AlreadyProvisioned)
        ));
        let owner_a_again = manager.unlock(b"owner-a").unwrap();
        assert_eq!(
            owner_a_again
                .open(b"record", &ciphertext)
                .unwrap()
                .as_slice(),
            b"secret"
        );
        let owner_b = manager.provision(b"owner-b").unwrap();
        assert!(owner_b.open(b"record", &ciphertext).is_err());
        manager.revoke(b"owner-a").unwrap();
        assert!(matches!(
            manager.unlock(b"owner-a"),
            Err(VaultKeyError::NotProvisioned)
        ));
    }

    #[test]
    fn external_anchor_is_monotonic_and_group_scoped() {
        let manager = RollbackAnchorManager::new(MemoryStore::default());
        let first = StateAnchor {
            group_id: "group-a".into(),
            state_version: 4,
            encrypted_state_digest: [4; 32],
        };
        manager.advance(b"owner-a", &first).unwrap();
        assert_eq!(
            manager.load(b"owner-a", "group-a").unwrap(),
            Some(first.clone())
        );
        assert_eq!(manager.load(b"owner-a", "group-b").unwrap(), None);
        let older = StateAnchor {
            state_version: 3,
            ..first.clone()
        };
        assert!(matches!(
            manager.advance(b"owner-a", &older),
            Err(VaultKeyError::RollbackDetected)
        ));
        let replaced = StateAnchor {
            encrypted_state_digest: [9; 32],
            ..first
        };
        assert!(matches!(
            manager.advance(b"owner-a", &replaced),
            Err(VaultKeyError::RollbackDetected)
        ));
    }
}
