use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};
use thiserror::Error;
use zeroize::Zeroizing;

pub const ATTACHMENT_CHUNK_BYTES: usize = 1024 * 1024;
pub const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;

pub struct AttachmentKey(Zeroizing<[u8; 32]>);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedAttachment {
    pub file_id: [u8; 16],
    pub nonce_prefix: [u8; 8],
    pub plaintext_size: u64,
    pub chunk_size: u32,
    pub ciphertext_hashes: Vec<[u8; 32]>,
    pub chunks: Vec<Vec<u8>>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AttachmentError {
    #[error("attachment is empty or exceeds 25 MiB")]
    InvalidSize,
    #[error("attachment manifest is invalid")]
    InvalidManifest,
    #[error("attachment authentication failed")]
    AuthenticationFailed,
}

impl AttachmentKey {
    pub fn generate() -> Self {
        let mut key = [0u8; 32];
        OsRng.fill_bytes(&mut key);
        Self(Zeroizing::new(key))
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, AttachmentError> {
        let key: [u8; 32] = bytes
            .try_into()
            .map_err(|_| AttachmentError::InvalidManifest)?;
        Ok(Self(Zeroizing::new(key)))
    }

    /// Must be included only inside an authenticated MLS application message.
    pub fn expose_for_mls(&self) -> [u8; 32] {
        *self.0
    }
}

impl EncryptedAttachment {
    pub fn encrypt(plaintext: &[u8], key: &AttachmentKey) -> Result<Self, AttachmentError> {
        if plaintext.is_empty() || plaintext.len() > MAX_ATTACHMENT_BYTES {
            return Err(AttachmentError::InvalidSize);
        }
        let mut file_id = [0u8; 16];
        let mut nonce_prefix = [0u8; 8];
        OsRng.fill_bytes(&mut file_id);
        OsRng.fill_bytes(&mut nonce_prefix);
        let chunk_count = plaintext.len().div_ceil(ATTACHMENT_CHUNK_BYTES);
        let cipher = Aes256Gcm::new_from_slice(key.0.as_ref())
            .map_err(|_| AttachmentError::InvalidManifest)?;
        let mut chunks = Vec::with_capacity(chunk_count);
        let mut ciphertext_hashes = Vec::with_capacity(chunk_count);
        for (index, chunk) in plaintext.chunks(ATTACHMENT_CHUNK_BYTES).enumerate() {
            let nonce = nonce(&nonce_prefix, index)?;
            let aad = chunk_aad(&file_id, index, chunk_count, plaintext.len())?;
            let ciphertext = cipher
                .encrypt(
                    Nonce::from_slice(&nonce),
                    Payload {
                        msg: chunk,
                        aad: &aad,
                    },
                )
                .map_err(|_| AttachmentError::AuthenticationFailed)?;
            ciphertext_hashes.push(Sha256::digest(&ciphertext).into());
            chunks.push(ciphertext);
        }
        Ok(Self {
            file_id,
            nonce_prefix,
            plaintext_size: plaintext.len() as u64,
            chunk_size: ATTACHMENT_CHUNK_BYTES as u32,
            ciphertext_hashes,
            chunks,
        })
    }

    pub fn decrypt(&self, key: &AttachmentKey) -> Result<Zeroizing<Vec<u8>>, AttachmentError> {
        self.validate_manifest()?;
        let expected_size =
            usize::try_from(self.plaintext_size).map_err(|_| AttachmentError::InvalidManifest)?;
        let cipher = Aes256Gcm::new_from_slice(key.0.as_ref())
            .map_err(|_| AttachmentError::InvalidManifest)?;
        let mut plaintext = Zeroizing::new(Vec::with_capacity(expected_size));
        for (index, ciphertext) in self.chunks.iter().enumerate() {
            if <[u8; 32]>::from(Sha256::digest(ciphertext)) != self.ciphertext_hashes[index] {
                return Err(AttachmentError::AuthenticationFailed);
            }
            let nonce = nonce(&self.nonce_prefix, index)?;
            let aad = chunk_aad(&self.file_id, index, self.chunks.len(), expected_size)?;
            let chunk = cipher
                .decrypt(
                    Nonce::from_slice(&nonce),
                    Payload {
                        msg: ciphertext,
                        aad: &aad,
                    },
                )
                .map_err(|_| AttachmentError::AuthenticationFailed)?;
            plaintext.extend_from_slice(&chunk);
        }
        if plaintext.len() != expected_size {
            return Err(AttachmentError::InvalidManifest);
        }
        Ok(plaintext)
    }

    fn validate_manifest(&self) -> Result<(), AttachmentError> {
        let size =
            usize::try_from(self.plaintext_size).map_err(|_| AttachmentError::InvalidManifest)?;
        if size == 0
            || size > MAX_ATTACHMENT_BYTES
            || self.chunk_size as usize != ATTACHMENT_CHUNK_BYTES
            || self.chunks.is_empty()
            || self.chunks.len() != self.ciphertext_hashes.len()
            || self.chunks.len() != size.div_ceil(ATTACHMENT_CHUNK_BYTES)
            || self
                .chunks
                .iter()
                .any(|chunk| chunk.len() <= 16 || chunk.len() > ATTACHMENT_CHUNK_BYTES + 16)
        {
            return Err(AttachmentError::InvalidManifest);
        }
        Ok(())
    }
}

fn nonce(prefix: &[u8; 8], index: usize) -> Result<[u8; 12], AttachmentError> {
    let index = u32::try_from(index).map_err(|_| AttachmentError::InvalidManifest)?;
    let mut nonce = [0u8; 12];
    nonce[..8].copy_from_slice(prefix);
    nonce[8..].copy_from_slice(&index.to_be_bytes());
    Ok(nonce)
}

fn chunk_aad(
    file_id: &[u8; 16],
    index: usize,
    count: usize,
    total: usize,
) -> Result<Vec<u8>, AttachmentError> {
    let index = u32::try_from(index).map_err(|_| AttachmentError::InvalidManifest)?;
    let count = u32::try_from(count).map_err(|_| AttachmentError::InvalidManifest)?;
    let total = u64::try_from(total).map_err(|_| AttachmentError::InvalidManifest)?;
    let mut aad = Vec::with_capacity(48);
    aad.extend_from_slice(b"voko.e2ee.attachment/1");
    aad.extend_from_slice(file_id);
    aad.extend_from_slice(&index.to_be_bytes());
    aad.extend_from_slice(&count.to_be_bytes());
    aad.extend_from_slice(&total.to_be_bytes());
    Ok(aad)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunked_attachment_round_trips_and_detects_corruption() {
        let key = AttachmentKey::generate();
        let plaintext = vec![0x5a; ATTACHMENT_CHUNK_BYTES * 2 + 17];
        let mut encrypted = EncryptedAttachment::encrypt(&plaintext, &key).unwrap();
        assert_eq!(encrypted.chunks.len(), 3);
        assert_eq!(encrypted.decrypt(&key).unwrap().as_slice(), plaintext);
        encrypted.chunks[1][3] ^= 1;
        assert_eq!(
            encrypted.decrypt(&key),
            Err(AttachmentError::AuthenticationFailed)
        );
    }

    #[test]
    fn each_file_uses_a_distinct_key_nonce_domain_and_size_is_bounded() {
        let first_key = AttachmentKey::generate();
        let second_key = AttachmentKey::generate();
        let first = EncryptedAttachment::encrypt(b"same file", &first_key).unwrap();
        let second = EncryptedAttachment::encrypt(b"same file", &second_key).unwrap();
        assert_ne!(first.file_id, second.file_id);
        assert_ne!(first.nonce_prefix, second.nonce_prefix);
        assert_ne!(first.chunks, second.chunks);
        assert_eq!(
            EncryptedAttachment::encrypt(&[], &first_key),
            Err(AttachmentError::InvalidSize)
        );
        assert_eq!(
            EncryptedAttachment::encrypt(&vec![0; MAX_ATTACHMENT_BYTES + 1], &first_key),
            Err(AttachmentError::InvalidSize)
        );
    }
}
