//! Experimental, network-free E2EE core. This crate is not wired into the
//! production VOKO message path.

mod aad;
mod envelope;
mod identity;
mod key_package;
mod lifecycle;
mod mls;
mod outbox;
#[cfg(not(target_arch = "wasm32"))]
mod persistence;
mod state_cache;
mod vault;

pub use aad::{AadError, CanonicalAad, E2EE_CONTENT_TYPE, E2EE_PROTOCOL_VERSION};
pub use envelope::{EnvelopeError, WireEnvelope, MAX_TEXT_CIPHERTEXT_BYTES};
pub use identity::{CredentialIdentityError, DeviceCredentialIdentity, DeviceRole};
pub use key_package::{KeyPackageLedger, KeyPackageLedgerError};
pub use lifecycle::{EstablishmentEvent, EstablishmentState, LifecycleError};
pub use mls::{DirectGroup, DirectGroupError, DirectGroupPair};
pub use outbox::{OutboxError, OutboxRecord, OutboxState, PreparedOutbox};
#[cfg(not(target_arch = "wasm32"))]
pub use persistence::{
    AtomicStateStore, ClaimedDelivery, PersistenceError, StateAnchor, StoredDelivery,
};
pub use state_cache::{BoundedSecretCache, CacheError};
pub use vault::{EncryptedVault, VaultError, VaultKdfParams};
