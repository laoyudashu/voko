use std::collections::BTreeMap;

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientReleaseManifest {
    pub format_version: u16,
    pub release_id: String,
    pub created_at_ms: u64,
    pub assets: BTreeMap<String, [u8; 32]>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedClientRelease {
    pub manifest: Vec<u8>,
    pub signature: [u8; 64],
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ClientReleaseError {
    #[error("invalid signed client release")]
    InvalidManifest,
    #[error("client release signature is not trusted")]
    InvalidSignature,
    #[error("client release asset digest mismatch")]
    AssetMismatch,
}

impl ClientReleaseManifest {
    pub fn new(
        release_id: String,
        created_at_ms: u64,
        assets: impl IntoIterator<Item = (String, Vec<u8>)>,
    ) -> Result<Self, ClientReleaseError> {
        if release_id.is_empty()
            || release_id.len() > 256
            || release_id.chars().any(char::is_control)
        {
            return Err(ClientReleaseError::InvalidManifest);
        }
        let mut digests = BTreeMap::new();
        for (name, bytes) in assets {
            if name.is_empty()
                || name.len() > 512
                || name.starts_with('/')
                || name.contains("..")
                || name.chars().any(char::is_control)
                || bytes.is_empty()
                || digests.insert(name, Sha256::digest(bytes).into()).is_some()
            {
                return Err(ClientReleaseError::InvalidManifest);
            }
        }
        if digests.is_empty() {
            return Err(ClientReleaseError::InvalidManifest);
        }
        Ok(Self {
            format_version: 1,
            release_id,
            created_at_ms,
            assets: digests,
        })
    }

    pub fn sign(
        &self,
        release_key: &SigningKey,
    ) -> Result<SignedClientRelease, ClientReleaseError> {
        let manifest = serde_json::to_vec(self).map_err(|_| ClientReleaseError::InvalidManifest)?;
        let signature = release_key.sign(&manifest).to_bytes();
        Ok(SignedClientRelease {
            manifest,
            signature,
        })
    }
}

impl SignedClientRelease {
    pub fn verify(
        &self,
        pinned_release_key: &[u8; 32],
        assets: &BTreeMap<String, Vec<u8>>,
    ) -> Result<ClientReleaseManifest, ClientReleaseError> {
        let key = VerifyingKey::from_bytes(pinned_release_key)
            .map_err(|_| ClientReleaseError::InvalidSignature)?;
        key.verify(&self.manifest, &Signature::from_bytes(&self.signature))
            .map_err(|_| ClientReleaseError::InvalidSignature)?;
        let manifest: ClientReleaseManifest = serde_json::from_slice(&self.manifest)
            .map_err(|_| ClientReleaseError::InvalidManifest)?;
        if manifest.format_version != 1 || manifest.assets.len() != assets.len() {
            return Err(ClientReleaseError::InvalidManifest);
        }
        for (name, expected) in &manifest.assets {
            let Some(bytes) = assets.get(name) else {
                return Err(ClientReleaseError::AssetMismatch);
            };
            if <[u8; 32]>::from(Sha256::digest(bytes)) != *expected {
                return Err(ClientReleaseError::AssetMismatch);
            }
        }
        Ok(manifest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_client_verifies_pinned_release_key_and_every_asset() {
        let release_key = SigningKey::from_bytes(&[9u8; 32]);
        let manifest = ClientReleaseManifest::new(
            "voko-e2ee-client-0.1.0".into(),
            1_000,
            [
                ("client.js".into(), b"trusted javascript".to_vec()),
                ("crypto.wasm".into(), b"trusted wasm".to_vec()),
            ],
        )
        .unwrap();
        let signed = manifest.sign(&release_key).unwrap();
        let mut assets = BTreeMap::from([
            ("client.js".into(), b"trusted javascript".to_vec()),
            ("crypto.wasm".into(), b"trusted wasm".to_vec()),
        ]);
        signed
            .verify(&release_key.verifying_key().to_bytes(), &assets)
            .unwrap();
        assets.insert("client.js".into(), b"replacement javascript".to_vec());
        assert_eq!(
            signed.verify(&release_key.verifying_key().to_bytes(), &assets),
            Err(ClientReleaseError::AssetMismatch)
        );
        let other_key = SigningKey::from_bytes(&[8u8; 32]);
        assert_eq!(
            signed.verify(&other_key.verifying_key().to_bytes(), &assets),
            Err(ClientReleaseError::InvalidSignature)
        );
    }
}
