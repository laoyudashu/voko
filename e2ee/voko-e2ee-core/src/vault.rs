use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::{rngs::OsRng, RngCore};
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

const MAGIC: &[u8; 12] = b"VOKO-VLT-001";
const HEADER_LEN: usize = MAGIC.len() + 4 + 4 + 4 + 16 + 12;
const AAD: &[u8] = b"voko-e2ee-vault/1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VaultKdfParams {
    pub memory_kib: u32,
    pub iterations: u32,
    pub lanes: u32,
}

impl Default for VaultKdfParams {
    fn default() -> Self {
        Self {
            memory_kib: 64 * 1024,
            iterations: 3,
            lanes: 1,
        }
    }
}

impl VaultKdfParams {
    fn validate(self) -> Result<Params, VaultError> {
        if self.memory_kib < 64 * 1024 || self.iterations < 3 || self.lanes == 0 {
            return Err(VaultError::WeakKdf);
        }
        Params::new(self.memory_kib, self.iterations, self.lanes, Some(32))
            .map_err(|_| VaultError::InvalidFormat)
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum VaultError {
    #[error("vault passphrase must not be empty")]
    EmptyPassphrase,
    #[error("vault KDF parameters are below the security floor")]
    WeakKdf,
    #[error("invalid vault format")]
    InvalidFormat,
    #[error("vault authentication failed")]
    AuthenticationFailed,
}

pub struct EncryptedVault;

impl EncryptedVault {
    pub fn seal(
        plaintext: &[u8],
        passphrase: &[u8],
        params: VaultKdfParams,
    ) -> Result<Vec<u8>, VaultError> {
        if passphrase.is_empty() {
            return Err(VaultError::EmptyPassphrase);
        }
        let argon_params = params.validate()?;
        let mut salt = [0u8; 16];
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut salt);
        OsRng.fill_bytes(&mut nonce);
        let mut key = Zeroizing::new([0u8; 32]);
        derive_key(passphrase, &salt, argon_params, key.as_mut())?;

        let cipher =
            Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| VaultError::InvalidFormat)?;
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: AAD,
                },
            )
            .map_err(|_| VaultError::AuthenticationFailed)?;

        let mut output = Vec::with_capacity(HEADER_LEN + ciphertext.len());
        output.extend_from_slice(MAGIC);
        output.extend_from_slice(&params.memory_kib.to_be_bytes());
        output.extend_from_slice(&params.iterations.to_be_bytes());
        output.extend_from_slice(&params.lanes.to_be_bytes());
        output.extend_from_slice(&salt);
        output.extend_from_slice(&nonce);
        output.extend_from_slice(&ciphertext);
        salt.zeroize();
        nonce.zeroize();
        Ok(output)
    }

    pub fn open(ciphertext: &[u8], passphrase: &[u8]) -> Result<Zeroizing<Vec<u8>>, VaultError> {
        if passphrase.is_empty() {
            return Err(VaultError::EmptyPassphrase);
        }
        if ciphertext.len() <= HEADER_LEN || &ciphertext[..MAGIC.len()] != MAGIC {
            return Err(VaultError::InvalidFormat);
        }
        let mut cursor = MAGIC.len();
        let memory_kib = read_u32(ciphertext, &mut cursor)?;
        let iterations = read_u32(ciphertext, &mut cursor)?;
        let lanes = read_u32(ciphertext, &mut cursor)?;
        let params = VaultKdfParams {
            memory_kib,
            iterations,
            lanes,
        }
        .validate()?;
        let salt = ciphertext
            .get(cursor..cursor + 16)
            .ok_or(VaultError::InvalidFormat)?;
        cursor += 16;
        let nonce = ciphertext
            .get(cursor..cursor + 12)
            .ok_or(VaultError::InvalidFormat)?;
        cursor += 12;

        let mut key = Zeroizing::new([0u8; 32]);
        derive_key(passphrase, salt, params, key.as_mut())?;
        let cipher =
            Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| VaultError::InvalidFormat)?;
        cipher
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: &ciphertext[cursor..],
                    aad: AAD,
                },
            )
            .map(Zeroizing::new)
            .map_err(|_| VaultError::AuthenticationFailed)
    }
}

fn derive_key(
    passphrase: &[u8],
    salt: &[u8],
    params: Params,
    output: &mut [u8],
) -> Result<(), VaultError> {
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(passphrase, salt, output)
        .map_err(|_| VaultError::InvalidFormat)
}

fn read_u32(input: &[u8], cursor: &mut usize) -> Result<u32, VaultError> {
    let bytes: [u8; 4] = input
        .get(*cursor..*cursor + 4)
        .ok_or(VaultError::InvalidFormat)?
        .try_into()
        .map_err(|_| VaultError::InvalidFormat)?;
    *cursor += 4;
    Ok(u32::from_be_bytes(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_randomized_ciphertext() {
        let first = EncryptedVault::seal(
            b"owner secret",
            b"correct horse battery staple",
            VaultKdfParams::default(),
        )
        .unwrap();
        let second = EncryptedVault::seal(
            b"owner secret",
            b"correct horse battery staple",
            VaultKdfParams::default(),
        )
        .unwrap();
        assert_ne!(first, second);
        assert_eq!(
            EncryptedVault::open(&first, b"correct horse battery staple")
                .unwrap()
                .as_slice(),
            b"owner secret"
        );
    }

    #[test]
    fn wrong_passphrase_and_tampering_have_the_same_failure() {
        let mut sealed = EncryptedVault::seal(
            b"owner secret",
            b"correct passphrase",
            VaultKdfParams::default(),
        )
        .unwrap();
        assert_eq!(
            EncryptedVault::open(&sealed, b"wrong passphrase"),
            Err(VaultError::AuthenticationFailed)
        );
        let last = sealed.len() - 1;
        sealed[last] ^= 1;
        assert_eq!(
            EncryptedVault::open(&sealed, b"correct passphrase"),
            Err(VaultError::AuthenticationFailed)
        );
    }

    #[test]
    fn refuses_weakened_kdf_parameters() {
        assert_eq!(
            EncryptedVault::seal(
                b"secret",
                b"passphrase",
                VaultKdfParams {
                    memory_kib: 1024,
                    iterations: 1,
                    lanes: 1
                }
            ),
            Err(VaultError::WeakKdf)
        );
    }
}
