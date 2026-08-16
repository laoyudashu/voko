//! Experimental, network-free E2EE core. This crate is not wired into the
//! production VOKO message path.

mod aad;
mod envelope;
mod identity;
mod key_package;
mod lifecycle;
mod mls;
mod outbox;
mod pcs;
#[cfg(not(target_arch = "wasm32"))]
mod persistence;
mod recovery;
mod state_cache;
#[cfg(not(target_arch = "wasm32"))]
mod system_key;
mod vault;

pub use aad::{AadError, CanonicalAad, E2EE_CONTENT_TYPE, E2EE_PROTOCOL_VERSION};
pub use envelope::{EnvelopeError, WireEnvelope, MAX_TEXT_CIPHERTEXT_BYTES};
pub use identity::{CredentialIdentityError, DeviceCredentialIdentity, DeviceRole};
pub use key_package::{KeyPackageLedger, KeyPackageLedgerError};
pub use lifecycle::{EstablishmentEvent, EstablishmentState, LifecycleError};
pub use mls::{
    DirectCreatorEndpoint, DirectGroup, DirectGroupError, DirectGroupPair, DirectRecipientEndpoint,
    PreparedDirectAdd,
};
pub use outbox::{OutboxError, OutboxRecord, OutboxState, PreparedOutbox};
pub use pcs::{PcsPolicyError, PcsUpdatePolicy, PcsUpdateTracker};
#[cfg(not(target_arch = "wasm32"))]
pub use persistence::{
    AtomicStateStore, ClaimedDelivery, ClaimedReceived, DeliveryKind, DeviceStatus,
    KeyPackageBinding, PersistenceError, PinStatus, StateAnchor, StoredDelivery,
};
pub use recovery::{ArchivedMessage, ReadOnlyArchive, RecoveryError, ReplacementDeviceRequirement};
pub use state_cache::{BoundedSecretCache, CacheError};
#[cfg(not(target_arch = "wasm32"))]
pub use system_key::{
    RollbackAnchorManager, SystemWrappingKeyStore, VaultKeyError, VaultKeyManager, WrappingKeyStore,
};
pub use vault::{EncryptedVault, RecordVault, VaultError, VaultKdfParams};
