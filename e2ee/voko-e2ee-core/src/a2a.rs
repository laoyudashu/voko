use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use hkdf::Hkdf;
use rand::{rngs::OsRng, RngCore};
use sha2::Sha256;
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

pub const A2A_E2EE_PROTOCOL: &str = "voko.a2a.e2ee/1";
const MAGIC: &[u8; 12] = b"VOKO-A2A-001";
const MAX_FIELD: usize = 2048;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum A2aE2eeRequirement {
    Optional,
    Required,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum A2aE2eeNegotiation {
    TransportOnly,
    E2eeV1,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct A2aKeyScope {
    pub sender_agent_did: Vec<u8>,
    pub recipient_agent_did: Vec<u8>,
    pub context_id: Vec<u8>,
    pub task_id: Vec<u8>,
}

pub struct A2aContextKey(Zeroizing<[u8; 32]>);

#[derive(Debug, Error, PartialEq, Eq)]
pub enum A2aE2eeError {
    #[error("remote Agent does not support required A2A E2EE")]
    RequiredCapabilityUnavailable,
    #[error("invalid A2A E2EE key scope")]
    InvalidScope,
    #[error("A2A E2EE authentication failed")]
    AuthenticationFailed,
}

pub fn negotiate(
    local_supports_v1: bool,
    remote_supports_v1: bool,
    requirement: A2aE2eeRequirement,
) -> Result<A2aE2eeNegotiation, A2aE2eeError> {
    if local_supports_v1 && remote_supports_v1 {
        return Ok(A2aE2eeNegotiation::E2eeV1);
    }
    if requirement == A2aE2eeRequirement::Required {
        return Err(A2aE2eeError::RequiredCapabilityUnavailable);
    }
    Ok(A2aE2eeNegotiation::TransportOnly)
}

impl A2aKeyScope {
    pub fn encode(&self) -> Result<Vec<u8>, A2aE2eeError> {
        let mut output = Vec::with_capacity(128);
        output.extend_from_slice(MAGIC);
        for value in [
            &self.sender_agent_did,
            &self.recipient_agent_did,
            &self.context_id,
            &self.task_id,
        ] {
            if value.is_empty() || value.len() > MAX_FIELD {
                return Err(A2aE2eeError::InvalidScope);
            }
            output.extend_from_slice(&(value.len() as u16).to_be_bytes());
            output.extend_from_slice(value);
        }
        Ok(output)
    }
}

impl A2aContextKey {
    /// The root secret must come from a separately authenticated A2A E2EE
    /// handshake. DID signatures authenticate that handshake but do not serve
    /// as encryption keys.
    pub fn derive(root_secret: &[u8], scope: &A2aKeyScope) -> Result<Self, A2aE2eeError> {
        if root_secret.len() < 32 {
            return Err(A2aE2eeError::InvalidScope);
        }
        let scope = scope.encode()?;
        let hkdf = Hkdf::<Sha256>::new(Some(b"voko.a2a.e2ee/1"), root_secret);
        let mut key = [0u8; 32];
        hkdf.expand(&scope, &mut key)
            .map_err(|_| A2aE2eeError::InvalidScope)?;
        Ok(Self(Zeroizing::new(key)))
    }

    pub fn seal(&self, scope: &A2aKeyScope, plaintext: &[u8]) -> Result<Vec<u8>, A2aE2eeError> {
        let aad = scope.encode()?;
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let cipher =
            Aes256Gcm::new_from_slice(self.0.as_ref()).map_err(|_| A2aE2eeError::InvalidScope)?;
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: &aad,
                },
            )
            .map_err(|_| A2aE2eeError::AuthenticationFailed)?;
        let mut output = Vec::with_capacity(12 + ciphertext.len());
        output.extend_from_slice(&nonce);
        output.extend_from_slice(&ciphertext);
        nonce.zeroize();
        Ok(output)
    }

    pub fn open(
        &self,
        scope: &A2aKeyScope,
        ciphertext: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, A2aE2eeError> {
        if ciphertext.len() <= 12 {
            return Err(A2aE2eeError::AuthenticationFailed);
        }
        let aad = scope.encode()?;
        let cipher =
            Aes256Gcm::new_from_slice(self.0.as_ref()).map_err(|_| A2aE2eeError::InvalidScope)?;
        cipher
            .decrypt(
                Nonce::from_slice(&ciphertext[..12]),
                Payload {
                    msg: &ciphertext[12..],
                    aad: &aad,
                },
            )
            .map(Zeroizing::new)
            .map_err(|_| A2aE2eeError::AuthenticationFailed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(task: &[u8]) -> A2aKeyScope {
        A2aKeyScope {
            sender_agent_did: b"did:voko:sender".to_vec(),
            recipient_agent_did: b"did:voko:recipient".to_vec(),
            context_id: b"context-1".to_vec(),
            task_id: task.to_vec(),
        }
    }

    #[test]
    fn required_negotiation_never_downgrades() {
        assert_eq!(
            negotiate(true, false, A2aE2eeRequirement::Required),
            Err(A2aE2eeError::RequiredCapabilityUnavailable)
        );
        assert_eq!(
            negotiate(true, true, A2aE2eeRequirement::Required),
            Ok(A2aE2eeNegotiation::E2eeV1)
        );
    }

    #[test]
    fn task_scopes_derive_distinct_keys_and_reject_cross_task_ciphertext() {
        let root = [7u8; 32];
        let first_scope = scope(b"task-1");
        let second_scope = scope(b"task-2");
        let first = A2aContextKey::derive(&root, &first_scope).unwrap();
        let second = A2aContextKey::derive(&root, &second_scope).unwrap();
        let ciphertext = first.seal(&first_scope, b"A2A artifact text").unwrap();
        assert_eq!(
            first.open(&first_scope, &ciphertext).unwrap().as_slice(),
            b"A2A artifact text"
        );
        assert_eq!(
            second.open(&second_scope, &ciphertext),
            Err(A2aE2eeError::AuthenticationFailed)
        );
        assert_eq!(
            first.open(&second_scope, &ciphertext),
            Err(A2aE2eeError::AuthenticationFailed)
        );
    }
}
