//! Experimental, network-free E2EE core. This crate is not wired into the
//! production VOKO message path.

mod a2a;
mod aad;
mod attachment;
mod envelope;
mod group_policy;
mod identity;
mod key_package;
mod lifecycle;
mod mls;
mod outbox;
mod pcs;
#[cfg(not(target_arch = "wasm32"))]
mod persistence;
mod recovery;
mod release_manifest;
mod rollout;
mod state_cache;
#[cfg(not(target_arch = "wasm32"))]
mod system_key;
mod transparency;
mod vault;

pub use a2a::{
    negotiate as negotiate_a2a_e2ee, A2aContextKey, A2aE2eeError, A2aE2eeNegotiation,
    A2aE2eeRequirement, A2aKeyScope, A2A_E2EE_PROTOCOL,
};
pub use aad::{AadError, CanonicalAad, E2EE_CONTENT_TYPE, E2EE_PROTOCOL_VERSION};
pub use attachment::{
    AttachmentError, AttachmentKey, EncryptedAttachment, ATTACHMENT_CHUNK_BYTES,
    MAX_ATTACHMENT_BYTES,
};
pub use envelope::{EnvelopeError, WireEnvelope, MAX_TEXT_CIPHERTEXT_BYTES};
pub use group_policy::{
    EncryptedGroupContent, GroupOperation, GroupOperationMetadata, GroupPolicyError, GroupRole,
};
pub use identity::{CredentialIdentityError, DeviceCredentialIdentity, DeviceRole};
pub use key_package::{KeyPackageLedger, KeyPackageLedgerError, KeyPackageReplenishmentPolicy};
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
pub use release_manifest::{ClientReleaseError, ClientReleaseManifest, SignedClientRelease};
pub use rollout::{
    ConversationSecurityState, E2eeRolloutPolicy, RolloutDecision, RolloutError, RolloutMode,
};
pub use state_cache::{BoundedSecretCache, CacheError};
#[cfg(not(target_arch = "wasm32"))]
pub use system_key::{
    RollbackAnchorManager, SystemWrappingKeyStore, VaultKeyError, VaultKeyManager, WrappingKeyStore,
};
pub use transparency::{
    verify_inclusion, verify_witnesses, DirectoryKeyEntry, TransparencyCheckpoint,
    TransparencyError, TransparencyLog, TransparencyWitness, WitnessedCheckpoint,
};
pub use vault::{EncryptedVault, RecordVault, VaultError, VaultKdfParams};
