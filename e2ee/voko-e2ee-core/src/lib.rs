//! Experimental, network-free E2EE core. This crate is not wired into the
//! production VOKO message path.

mod aad;
mod key_package;
mod lifecycle;
mod mls;
mod outbox;

pub use aad::{AadError, CanonicalAad, E2EE_CONTENT_TYPE, E2EE_PROTOCOL_VERSION};
pub use key_package::{KeyPackageLedger, KeyPackageLedgerError};
pub use lifecycle::{EstablishmentEvent, EstablishmentState, LifecycleError};
pub use mls::{DirectGroup, DirectGroupError, DirectGroupPair};
pub use outbox::{OutboxError, OutboxRecord, OutboxState, PreparedOutbox};
