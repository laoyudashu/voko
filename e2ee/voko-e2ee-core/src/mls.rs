use openmls::prelude::{
    BasicCredential, Ciphersuite, CredentialWithKey, Extensions, GroupId, KeyPackage,
    KeyPackageBundle, LeafNodeParameters, MlsGroup, MlsGroupCreateConfig, MlsGroupJoinConfig,
    MlsMessageBodyIn, MlsMessageIn, ProcessedMessageContent, ProtocolMessage, StagedWelcome,
};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::{signatures::Signer, types::SignatureScheme, OpenMlsProvider};
use serde::{Deserialize as SerdeDeserialize, Serialize as SerdeSerialize};
use thiserror::Error;
use tls_codec::{Deserialize, Serialize};

use crate::{
    CanonicalAad, DeviceCredentialIdentity, EstablishmentEvent, EstablishmentState,
    KeyPackageLedger,
};

const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

pub struct DirectGroup {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    group: MlsGroup,
}

pub struct DirectGroupPair {
    pub creator: DirectGroup,
    pub recipient: DirectGroup,
    pub state: EstablishmentState,
    pub key_package_reference: [u8; 32],
    pub serialized_recipient_key_package: Vec<u8>,
}

#[derive(Debug, Error)]
pub enum DirectGroupError {
    #[error("MLS operation failed: {0}")]
    Mls(String),
    #[error("expected an MLS application message")]
    NotApplicationMessage,
}

#[derive(SerdeSerialize, SerdeDeserialize)]
#[serde(deny_unknown_fields)]
struct DirectGroupSnapshot {
    version: u16,
    group_id: Vec<u8>,
    signer_public_key: Vec<u8>,
    storage: Vec<(Vec<u8>, Vec<u8>)>,
}

fn credential(
    identity: &[u8],
    provider: &OpenMlsRustCrypto,
) -> Result<(CredentialWithKey, SignatureKeyPair), DirectGroupError> {
    let basic = BasicCredential::new(identity.to_vec());
    let signer = SignatureKeyPair::new(SignatureScheme::ED25519)
        .map_err(|e| DirectGroupError::Mls(format!("signature key generation: {e:?}")))?;
    signer
        .store(provider.storage())
        .map_err(|e| DirectGroupError::Mls(format!("signature key persistence: {e:?}")))?;
    Ok((
        CredentialWithKey {
            credential: basic.into(),
            signature_key: signer.to_public_vec().into(),
        },
        signer,
    ))
}

fn key_package(
    provider: &OpenMlsRustCrypto,
    signer: &impl Signer,
    credential: CredentialWithKey,
) -> Result<KeyPackageBundle, DirectGroupError> {
    KeyPackage::builder()
        .key_package_extensions(Extensions::default())
        .build(CIPHERSUITE, provider, signer, credential)
        .map_err(|e| DirectGroupError::Mls(format!("key package creation: {e:?}")))
}

impl DirectGroupPair {
    pub fn establish_bound(
        group_id: &[u8],
        creator_identity: &DeviceCredentialIdentity,
        recipient_identity: &DeviceCredentialIdentity,
        ledger: &mut KeyPackageLedger,
    ) -> Result<Self, DirectGroupError> {
        DeviceCredentialIdentity::validate_direct_pair(creator_identity, recipient_identity)
            .map_err(|error| DirectGroupError::Mls(error.to_string()))?;
        Self::establish(
            group_id,
            &creator_identity
                .encode()
                .map_err(|error| DirectGroupError::Mls(error.to_string()))?,
            &recipient_identity
                .encode()
                .map_err(|error| DirectGroupError::Mls(error.to_string()))?,
            ledger,
        )
    }

    pub fn establish(
        group_id: &[u8],
        creator_identity: &[u8],
        recipient_identity: &[u8],
        ledger: &mut KeyPackageLedger,
    ) -> Result<Self, DirectGroupError> {
        let creator_provider = OpenMlsRustCrypto::default();
        let recipient_provider = OpenMlsRustCrypto::default();
        let (creator_credential, creator_signer) = credential(creator_identity, &creator_provider)?;
        let (recipient_credential, recipient_signer) =
            credential(recipient_identity, &recipient_provider)?;
        let recipient_key_package =
            key_package(&recipient_provider, &recipient_signer, recipient_credential)?;

        let serialized_key_package = recipient_key_package
            .key_package()
            .tls_serialize_detached()
            .map_err(|e| DirectGroupError::Mls(format!("key package serialization: {e:?}")))?;
        let key_package_reference = ledger
            .consume(&serialized_key_package, group_id)
            .map_err(|e| DirectGroupError::Mls(e.to_string()))?;

        let mut state = EstablishmentState::CreatedLocal;
        state = state
            .apply(EstablishmentEvent::ReserveKeyPackage)
            .map_err(|e| DirectGroupError::Mls(e.to_string()))?;

        let config = MlsGroupCreateConfig::builder()
            .ciphersuite(CIPHERSUITE)
            .use_ratchet_tree_extension(true)
            .build();
        let mut creator_group = MlsGroup::new_with_group_id(
            &creator_provider,
            &creator_signer,
            &config,
            GroupId::from_slice(group_id),
            creator_credential,
        )
        .map_err(|e| DirectGroupError::Mls(format!("group creation: {e:?}")))?;

        let (_commit, welcome, _group_info) = creator_group
            .add_members(
                &creator_provider,
                &creator_signer,
                core::slice::from_ref(recipient_key_package.key_package()),
            )
            .map_err(|e| DirectGroupError::Mls(format!("add member: {e:?}")))?;
        state = state
            .apply(EstablishmentEvent::CreateAddCommit)
            .map_err(|e| DirectGroupError::Mls(e.to_string()))?;

        // The delivery service acceptance is an application-level gate. Only
        // after it succeeds do we merge the pending creator commit.
        state = state
            .apply(EstablishmentEvent::AcceptCommit)
            .map_err(|e| DirectGroupError::Mls(e.to_string()))?;
        creator_group
            .merge_pending_commit(&creator_provider)
            .map_err(|e| DirectGroupError::Mls(format!("merge creator commit: {e:?}")))?;

        let welcome_bytes = welcome
            .tls_serialize_detached()
            .map_err(|e| DirectGroupError::Mls(format!("serialize Welcome: {e:?}")))?;
        let welcome = match MlsMessageIn::tls_deserialize_exact(&welcome_bytes)
            .map_err(|e| DirectGroupError::Mls(format!("parse Welcome: {e:?}")))?
            .extract()
        {
            MlsMessageBodyIn::Welcome(welcome) => welcome,
            _ => return Err(DirectGroupError::Mls("expected Welcome".into())),
        };
        state = state
            .apply(EstablishmentEvent::PersistWelcome)
            .map_err(|e| DirectGroupError::Mls(e.to_string()))?;
        let join_config = MlsGroupJoinConfig::builder()
            .use_ratchet_tree_extension(true)
            .build();
        let staged =
            StagedWelcome::new_from_welcome(&recipient_provider, &join_config, welcome, None)
                .map_err(|e| DirectGroupError::Mls(format!("stage Welcome: {e:?}")))?;
        let recipient_group = staged
            .into_group(&recipient_provider)
            .map_err(|e| DirectGroupError::Mls(format!("join recipient: {e:?}")))?;
        state = state
            .apply(EstablishmentEvent::JoinRecipient)
            .map_err(|e| DirectGroupError::Mls(e.to_string()))?;

        // In production this transition is driven by an encrypted and signed
        // acknowledgement from the recipient.
        state = state
            .apply(EstablishmentEvent::AcknowledgeEstablished)
            .map_err(|e| DirectGroupError::Mls(e.to_string()))?;
        state = state
            .apply(EstablishmentEvent::Activate)
            .map_err(|e| DirectGroupError::Mls(e.to_string()))?;

        Ok(Self {
            creator: DirectGroup {
                provider: creator_provider,
                signer: creator_signer,
                group: creator_group,
            },
            recipient: DirectGroup {
                provider: recipient_provider,
                signer: recipient_signer,
                group: recipient_group,
            },
            state,
            key_package_reference,
            serialized_recipient_key_package: serialized_key_package,
        })
    }
}

impl DirectGroup {
    pub fn signer_public_key(&self) -> Vec<u8> {
        self.signer.to_public_vec()
    }

    pub fn epoch(&self) -> u64 {
        self.group.epoch().as_u64()
    }

    /// Creates and stages a self-update. The caller must persist the pending
    /// snapshot and fixed Commit bytes before delivery, and must not merge it
    /// until the Delivery Service explicitly accepts that Commit.
    pub fn prepare_self_update(&mut self) -> Result<Vec<u8>, DirectGroupError> {
        let (commit, welcome, _) = self
            .group
            .self_update(&self.provider, &self.signer, LeafNodeParameters::default())
            .map_err(|error| DirectGroupError::Mls(format!("prepare self update: {error:?}")))?
            .into_messages();
        if welcome.is_some() {
            return Err(DirectGroupError::Mls(
                "unexpected Welcome in direct self update".into(),
            ));
        }
        commit
            .tls_serialize_detached()
            .map_err(|error| DirectGroupError::Mls(format!("serialize self update: {error:?}")))
    }

    pub fn accept_pending_self_update(&mut self) -> Result<(), DirectGroupError> {
        self.group
            .merge_pending_commit(&self.provider)
            .map_err(|error| DirectGroupError::Mls(format!("merge self update: {error:?}")))
    }

    pub fn apply_self_update(&mut self, commit: &[u8]) -> Result<(), DirectGroupError> {
        let input = MlsMessageIn::tls_deserialize_exact(commit)
            .map_err(|error| DirectGroupError::Mls(format!("parse self update: {error:?}")))?;
        let protocol = input
            .try_into_protocol_message()
            .map_err(|error| DirectGroupError::Mls(format!("expected self update: {error:?}")))?;
        let processed = self
            .group
            .process_message(&self.provider, protocol)
            .map_err(|error| DirectGroupError::Mls(format!("process self update: {error:?}")))?;
        match processed.into_content() {
            ProcessedMessageContent::StagedCommitMessage(staged) => self
                .group
                .merge_staged_commit(&self.provider, *staged)
                .map_err(|error| DirectGroupError::Mls(format!("merge remote update: {error:?}"))),
            _ => Err(DirectGroupError::NotApplicationMessage),
        }
    }

    /// Serializes the complete endpoint state for host-side authenticated
    /// encryption. The returned bytes contain secrets and must never be stored
    /// or logged without Vault protection.
    pub fn snapshot(&self) -> Result<Vec<u8>, DirectGroupError> {
        let mut storage: Vec<_> = self
            .provider
            .storage()
            .values
            .read()
            .map_err(|_| DirectGroupError::Mls("storage lock poisoned".into()))?
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        storage.sort_by(|left, right| left.0.cmp(&right.0));
        serde_json::to_vec(&DirectGroupSnapshot {
            version: 1,
            group_id: self.group.group_id().as_slice().to_vec(),
            signer_public_key: self.signer.to_public_vec(),
            storage,
        })
        .map_err(|error| DirectGroupError::Mls(format!("serialize group snapshot: {error}")))
    }

    /// Restores a snapshot only after the host has authenticated and decrypted
    /// it. Unknown versions and missing signer/group records fail closed.
    pub fn restore(snapshot: &[u8]) -> Result<Self, DirectGroupError> {
        let snapshot: DirectGroupSnapshot = serde_json::from_slice(snapshot)
            .map_err(|error| DirectGroupError::Mls(format!("parse group snapshot: {error}")))?;
        if snapshot.version != 1 || snapshot.group_id.is_empty() {
            return Err(DirectGroupError::Mls("unsupported group snapshot".into()));
        }
        let provider = OpenMlsRustCrypto::default();
        {
            let mut values = provider
                .storage()
                .values
                .write()
                .map_err(|_| DirectGroupError::Mls("storage lock poisoned".into()))?;
            for (key, value) in snapshot.storage {
                if key.is_empty() {
                    return Err(DirectGroupError::Mls("invalid snapshot storage key".into()));
                }
                values.insert(key, value);
            }
        }
        let signer = SignatureKeyPair::read(
            provider.storage(),
            &snapshot.signer_public_key,
            SignatureScheme::ED25519,
        )
        .ok_or_else(|| DirectGroupError::Mls("snapshot signer was not found".into()))?;
        let group = MlsGroup::load(provider.storage(), &GroupId::from_slice(&snapshot.group_id))
            .map_err(|error| DirectGroupError::Mls(format!("load snapshot group: {error:?}")))?
            .ok_or_else(|| DirectGroupError::Mls("snapshot group was not found".into()))?;
        Ok(Self {
            provider,
            signer,
            group,
        })
    }

    pub fn reload_from_storage(&mut self) -> Result<(), DirectGroupError> {
        let group_id = self.group.group_id().clone();
        self.group = MlsGroup::load(self.provider.storage(), &group_id)
            .map_err(|error| DirectGroupError::Mls(format!("load group: {error:?}")))?
            .ok_or_else(|| DirectGroupError::Mls("persisted group was not found".into()))?;
        Ok(())
    }

    pub fn encrypt(
        &mut self,
        aad: &CanonicalAad,
        plaintext: &[u8],
    ) -> Result<Vec<u8>, DirectGroupError> {
        if self.group.pending_commit().is_some() {
            return Err(DirectGroupError::Mls(
                "application send blocked while a Commit is pending".into(),
            ));
        }
        if aad.group_id.as_slice() != self.group.group_id().as_slice()
            || aad.epoch != self.group.epoch().as_u64()
        {
            return Err(DirectGroupError::Mls(
                "authenticated group or epoch mismatch".into(),
            ));
        }
        self.group.set_aad(
            aad.encode()
                .map_err(|e| DirectGroupError::Mls(e.to_string()))?,
        );
        self.group
            .create_message(&self.provider, &self.signer, plaintext)
            .map_err(|e| DirectGroupError::Mls(format!("encrypt message: {e:?}")))?
            .tls_serialize_detached()
            .map_err(|e| DirectGroupError::Mls(format!("serialize message: {e:?}")))
    }

    pub fn decrypt(
        &mut self,
        expected_aad: &CanonicalAad,
        ciphertext: &[u8],
    ) -> Result<Vec<u8>, DirectGroupError> {
        let input = MlsMessageIn::tls_deserialize_exact(ciphertext)
            .map_err(|e| DirectGroupError::Mls(format!("parse message: {e:?}")))?;
        let protocol: ProtocolMessage = input
            .try_into_protocol_message()
            .map_err(|e| DirectGroupError::Mls(format!("expected protocol message: {e:?}")))?;
        let expected = expected_aad
            .encode()
            .map_err(|e| DirectGroupError::Mls(e.to_string()))?;
        if protocol.group_id().as_slice() != expected_aad.group_id.as_slice()
            || protocol.epoch().as_u64() != expected_aad.epoch
        {
            return Err(DirectGroupError::Mls(
                "authenticated group or epoch mismatch".into(),
            ));
        }
        // Application traffic is always an MLS PrivateMessage. Comparing its
        // unverified AAD before decryption is only an early rejection gate;
        // OpenMLS still authenticates the same bytes below. This prevents a
        // forged outer route from consuming a secret-tree generation.
        match &protocol {
            ProtocolMessage::PrivateMessage(message) if message.aad() == expected => {}
            ProtocolMessage::PrivateMessage(_) => {
                return Err(DirectGroupError::Mls(
                    "authenticated routing mismatch".into(),
                ));
            }
            ProtocolMessage::PublicMessage(_) => {
                return Err(DirectGroupError::NotApplicationMessage);
            }
        }
        let processed = self
            .group
            .process_message(&self.provider, protocol)
            .map_err(|e| DirectGroupError::Mls(format!("decrypt message: {e:?}")))?;
        if processed.aad() != expected {
            return Err(DirectGroupError::Mls(
                "authenticated routing mismatch".into(),
            ));
        }
        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(message) => Ok(message.into_bytes()),
            _ => Err(DirectGroupError::NotApplicationMessage),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DeviceCredentialIdentity, DeviceRole, E2EE_CONTENT_TYPE, E2EE_PROTOCOL_VERSION};

    fn identity(role: DeviceRole, key: &[u8], agent: &[u8]) -> DeviceCredentialIdentity {
        DeviceCredentialIdentity {
            role,
            principal_id: b"principal-scope".to_vec(),
            device_key_id: key.to_vec(),
            key_epoch: 1,
            target_agent_did: agent.to_vec(),
        }
    }

    fn aad(group: &[u8], agent: &[u8], message: &[u8], sender: &[u8]) -> CanonicalAad {
        CanonicalAad {
            protocol_version: E2EE_PROTOCOL_VERSION,
            content_type: E2EE_CONTENT_TYPE,
            group_id: group.to_vec(),
            epoch: 1,
            target_agent_did: agent.to_vec(),
            conversation_scope: b"conversation-1".to_vec(),
            sender_device_key_id: sender.to_vec(),
            message_id: message.to_vec(),
            channel_type: 1,
        }
    }

    #[test]
    fn establishes_and_exchanges_bidirectional_text() {
        let mut ledger = KeyPackageLedger::default();
        let mut pair = DirectGroupPair::establish(
            b"group-1",
            b"browser-device-1",
            b"owner-device-1",
            &mut ledger,
        )
        .unwrap();
        assert_eq!(pair.state, EstablishmentState::Active);

        let first_aad = aad(
            b"group-1",
            b"did:voko:agent-1",
            b"message-1",
            b"browser-key-1",
        );
        let ciphertext = pair.creator.encrypt(&first_aad, b"hello agent").unwrap();
        assert!(!ciphertext
            .windows(b"hello agent".len())
            .any(|w| w == b"hello agent"));
        assert_eq!(
            pair.recipient.decrypt(&first_aad, &ciphertext).unwrap(),
            b"hello agent"
        );

        let reply_aad = aad(
            b"group-1",
            b"did:voko:agent-1",
            b"message-2",
            b"owner-key-1",
        );
        let reply = pair
            .recipient
            .encrypt(&reply_aad, b"hello visitor")
            .unwrap();
        assert_eq!(
            pair.creator.decrypt(&reply_aad, &reply).unwrap(),
            b"hello visitor"
        );
    }

    #[test]
    fn wrong_agent_binding_fails_closed() {
        let mut pair = DirectGroupPair::establish(
            b"group-2",
            b"browser-device-2",
            b"owner-device-2",
            &mut KeyPackageLedger::default(),
        )
        .unwrap();
        let correct = aad(
            b"group-2",
            b"did:voko:agent-a",
            b"message-a",
            b"browser-key-2",
        );
        let ciphertext = pair.creator.encrypt(&correct, b"secret").unwrap();
        let wrong = aad(
            b"group-2",
            b"did:voko:agent-b",
            b"message-a",
            b"browser-key-2",
        );
        assert!(pair.recipient.decrypt(&wrong, &ciphertext).is_err());
        assert_eq!(
            pair.recipient.decrypt(&correct, &ciphertext).unwrap(),
            b"secret"
        );
    }

    #[test]
    fn replayed_ciphertext_is_rejected() {
        let mut pair = DirectGroupPair::establish(
            b"group-3",
            b"browser-device-3",
            b"owner-device-3",
            &mut KeyPackageLedger::default(),
        )
        .unwrap();
        let route = aad(
            b"group-3",
            b"did:voko:agent-3",
            b"message-3",
            b"browser-key-3",
        );
        let ciphertext = pair.creator.encrypt(&route, b"once only").unwrap();
        assert_eq!(
            pair.recipient.decrypt(&route, &ciphertext).unwrap(),
            b"once only"
        );
        assert!(pair.recipient.decrypt(&route, &ciphertext).is_err());
    }

    #[test]
    fn bound_credentials_and_persisted_group_reload_keep_the_session() {
        let creator = identity(DeviceRole::Browser, b"browser-key-4", b"did:voko:agent-4");
        let recipient = identity(DeviceRole::OwnerDevice, b"owner-key-4", b"did:voko:agent-4");
        let mut pair = DirectGroupPair::establish_bound(
            b"group-4",
            &creator,
            &recipient,
            &mut KeyPackageLedger::default(),
        )
        .unwrap();
        pair.creator.reload_from_storage().unwrap();
        pair.recipient.reload_from_storage().unwrap();
        let route = aad(
            b"group-4",
            b"did:voko:agent-4",
            b"message-4",
            b"browser-key-4",
        );
        let ciphertext = pair.creator.encrypt(&route, b"after reload").unwrap();
        assert_eq!(
            pair.recipient.decrypt(&route, &ciphertext).unwrap(),
            b"after reload"
        );
    }

    #[test]
    fn serialized_snapshot_restores_the_next_mls_generation() {
        let mut pair = DirectGroupPair::establish(
            b"group-snapshot",
            b"browser-snapshot",
            b"owner-snapshot",
            &mut KeyPackageLedger::default(),
        )
        .unwrap();
        let first_route = aad(
            b"group-snapshot",
            b"did:voko:agent-snapshot",
            b"message-snapshot-1",
            b"browser-snapshot",
        );
        let first = pair
            .creator
            .encrypt(&first_route, b"before restart")
            .unwrap();
        assert_eq!(
            pair.recipient.decrypt(&first_route, &first).unwrap(),
            b"before restart"
        );

        let snapshot = pair.creator.snapshot().unwrap();
        let mut restored = DirectGroup::restore(&snapshot).unwrap();
        let second_route = aad(
            b"group-snapshot",
            b"did:voko:agent-snapshot",
            b"message-snapshot-2",
            b"browser-snapshot",
        );
        let second = restored.encrypt(&second_route, b"after restart").unwrap();
        assert_eq!(
            pair.recipient.decrypt(&second_route, &second).unwrap(),
            b"after restart"
        );
    }

    #[test]
    fn self_update_advances_only_after_delivery_acceptance_and_is_replay_safe() {
        let mut pair = DirectGroupPair::establish(
            b"group-pcs",
            b"browser-pcs",
            b"owner-pcs",
            &mut KeyPackageLedger::default(),
        )
        .unwrap();
        let prior_epoch = pair.creator.epoch();
        assert_eq!(pair.recipient.epoch(), prior_epoch);
        let commit = pair.creator.prepare_self_update().unwrap();
        assert_eq!(pair.creator.epoch(), prior_epoch);
        assert!(pair
            .creator
            .encrypt(
                &aad(
                    b"group-pcs",
                    b"did:voko:agent-pcs",
                    b"blocked-while-pending",
                    b"browser-pcs",
                ),
                b"must wait",
            )
            .is_err());

        pair.creator.accept_pending_self_update().unwrap();
        pair.recipient.apply_self_update(&commit).unwrap();
        assert_eq!(pair.creator.epoch(), prior_epoch + 1);
        assert_eq!(pair.recipient.epoch(), prior_epoch + 1);
        assert!(pair.recipient.apply_self_update(&commit).is_err());
        assert_eq!(pair.recipient.epoch(), prior_epoch + 1);

        let mut route = aad(
            b"group-pcs",
            b"did:voko:agent-pcs",
            b"after-pcs",
            b"browser-pcs",
        );
        route.epoch = pair.creator.epoch();
        let ciphertext = pair.creator.encrypt(&route, b"new epoch").unwrap();
        assert_eq!(
            pair.recipient.decrypt(&route, &ciphertext).unwrap(),
            b"new epoch"
        );
    }
}
