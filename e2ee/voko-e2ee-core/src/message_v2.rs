use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use hpke_rs::{
    hpke_types::{AeadAlgorithm, KdfAlgorithm, KemAlgorithm},
    Hpke, HpkePrivateKey, HpkePublicKey, Mode,
};
use hpke_rs_crypto::HpkeCrypto;
use hpke_rs_rust_crypto::HpkeRustCrypto;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use zeroize::{Zeroize, ZeroizeOnDrop};

pub const E2EE_V2_PROTOCOL: &str = "voko.e2ee/2";
pub const E2EE_V2_SUITE: &str = "X25519-HKDF-SHA256-CHACHA20POLY1305";
const HPKE_INFO: &[u8] = b"VOKO-E2EE-V2\0private-message";
const SIGN_DOMAIN: &[u8] = b"VOKO-E2EE-V2-SIGN\0";
const KEY_ID_DOMAIN: &[u8] = b"VOKO-E2EE-V2-KEY-ID\0";
const MAX_HEADER_FIELD_BYTES: usize = 1024;
const MAX_CIPHERTEXT_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DevicePublicBundleV2 {
    pub version: String,
    pub key_id: String,
    pub hpke_public_key: String,
    pub signing_public_key: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DevicePrivateBundleV2 {
    pub version: String,
    pub key_id: String,
    pub hpke_private_key: String,
    pub hpke_public_key: String,
    pub signing_private_key: String,
    pub signing_public_key: String,
}

impl core::fmt::Debug for DevicePrivateBundleV2 {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("DevicePrivateBundleV2")
            .field("version", &self.version)
            .field("key_id", &self.key_id)
            .field("hpke_private_key", &"***")
            .field("hpke_public_key", &self.hpke_public_key)
            .field("signing_private_key", &"***")
            .field("signing_public_key", &self.signing_public_key)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageContentKindV2 {
    Text,
    AttachmentManifest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageHeaderV2 {
    pub version: String,
    pub suite: String,
    pub message_id: String,
    pub conversation_id: String,
    pub channel_id: String,
    pub agent_did: String,
    pub sender_device_id: String,
    pub sender_key_id: String,
    pub recipient_device_id: String,
    pub recipient_key_id: String,
    pub created_at_ms: u64,
    pub content_kind: MessageContentKindV2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageEnvelopeV2 {
    #[serde(flatten)]
    pub header: MessageHeaderV2,
    pub enc: String,
    pub ciphertext: String,
    pub signature: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum MessageV2Error {
    #[error("E2EE_V2_INVALID_KEY")]
    InvalidKey,
    #[error("E2EE_V2_INVALID_HEADER")]
    InvalidHeader,
    #[error("E2EE_V2_INVALID_ENCODING")]
    InvalidEncoding,
    #[error("E2EE_V2_UNSUPPORTED")]
    Unsupported,
    #[error("E2EE_V2_SIGNATURE_INVALID")]
    SignatureInvalid,
    #[error("E2EE_V2_ENCRYPT_FAILED")]
    EncryptFailed,
    #[error("E2EE_V2_DECRYPT_FAILED")]
    DecryptFailed,
    #[error("E2EE_V2_CIPHERTEXT_TOO_LARGE")]
    CiphertextTooLarge,
}

fn hpke() -> Hpke<HpkeRustCrypto> {
    Hpke::new(
        Mode::Base,
        KemAlgorithm::DhKem25519,
        KdfAlgorithm::HkdfSha256,
        AeadAlgorithm::ChaCha20Poly1305,
    )
}

fn decode(value: &str) -> Result<Vec<u8>, MessageV2Error> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| MessageV2Error::InvalidEncoding)
}

fn array_32(value: &[u8]) -> Result<[u8; 32], MessageV2Error> {
    value.try_into().map_err(|_| MessageV2Error::InvalidKey)
}

fn key_id(hpke_public_key: &[u8], signing_public_key: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(KEY_ID_DOMAIN);
    digest.update((hpke_public_key.len() as u32).to_be_bytes());
    digest.update(hpke_public_key);
    digest.update((signing_public_key.len() as u32).to_be_bytes());
    digest.update(signing_public_key);
    URL_SAFE_NO_PAD.encode(digest.finalize())
}

fn canonical_header(header: &MessageHeaderV2) -> Result<Vec<u8>, MessageV2Error> {
    header.validate()?;
    serde_jcs::to_vec(header).map_err(|_| MessageV2Error::InvalidHeader)
}

fn append_length_prefixed(output: &mut Vec<u8>, value: &[u8]) -> Result<(), MessageV2Error> {
    let length = u32::try_from(value.len()).map_err(|_| MessageV2Error::InvalidEncoding)?;
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(value);
    Ok(())
}

fn signature_input(aad: &[u8], enc: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, MessageV2Error> {
    let mut output =
        Vec::with_capacity(SIGN_DOMAIN.len() + aad.len() + enc.len() + ciphertext.len() + 12);
    output.extend_from_slice(SIGN_DOMAIN);
    append_length_prefixed(&mut output, aad)?;
    append_length_prefixed(&mut output, enc)?;
    append_length_prefixed(&mut output, ciphertext)?;
    Ok(output)
}

fn validate_field(value: &str) -> Result<(), MessageV2Error> {
    if value.is_empty()
        || value.len() > MAX_HEADER_FIELD_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(MessageV2Error::InvalidHeader);
    }
    Ok(())
}

impl DevicePrivateBundleV2 {
    pub fn generate() -> Result<Self, MessageV2Error> {
        let mut hpke = hpke();
        let (hpke_private, hpke_public) = hpke
            .generate_key_pair()
            .map_err(|_| MessageV2Error::InvalidKey)?
            .into_keys();
        let mut signing_seed = [0u8; 32];
        OsRng.fill_bytes(&mut signing_seed);
        let signing = SigningKey::from_bytes(&signing_seed);
        let signing_public = signing.verifying_key().to_bytes();
        let result = Self {
            version: E2EE_V2_PROTOCOL.into(),
            key_id: key_id(hpke_public.as_slice(), &signing_public),
            hpke_private_key: URL_SAFE_NO_PAD.encode(hpke_private.as_slice()),
            hpke_public_key: URL_SAFE_NO_PAD.encode(hpke_public.as_slice()),
            signing_private_key: URL_SAFE_NO_PAD.encode(signing_seed),
            signing_public_key: URL_SAFE_NO_PAD.encode(signing_public),
        };
        signing_seed.zeroize();
        result.validate()?;
        Ok(result)
    }

    pub fn public_bundle(&self) -> Result<DevicePublicBundleV2, MessageV2Error> {
        self.validate()?;
        Ok(DevicePublicBundleV2 {
            version: self.version.clone(),
            key_id: self.key_id.clone(),
            hpke_public_key: self.hpke_public_key.clone(),
            signing_public_key: self.signing_public_key.clone(),
        })
    }

    pub fn validate(&self) -> Result<(), MessageV2Error> {
        if self.version != E2EE_V2_PROTOCOL {
            return Err(MessageV2Error::Unsupported);
        }
        let hpke_private = decode(&self.hpke_private_key)?;
        let hpke_public = decode(&self.hpke_public_key)?;
        let signing_private = array_32(&decode(&self.signing_private_key)?)?;
        let signing_public = array_32(&decode(&self.signing_public_key)?)?;
        if hpke_private.len() != 32 || hpke_public.len() != 32 {
            return Err(MessageV2Error::InvalidKey);
        }
        let derived_hpke_public =
            HpkeRustCrypto::secret_to_public(KemAlgorithm::DhKem25519, &hpke_private)
                .map_err(|_| MessageV2Error::InvalidKey)?;
        let derived_signing_public = SigningKey::from_bytes(&signing_private)
            .verifying_key()
            .to_bytes();
        if derived_hpke_public != hpke_public
            || derived_signing_public != signing_public
            || key_id(&hpke_public, &signing_public) != self.key_id
        {
            return Err(MessageV2Error::InvalidKey);
        }
        Ok(())
    }

    pub fn seal(
        &self,
        recipient: &DevicePublicBundleV2,
        header: MessageHeaderV2,
        plaintext: &[u8],
    ) -> Result<MessageEnvelopeV2, MessageV2Error> {
        self.validate()?;
        recipient.validate()?;
        if header.sender_key_id != self.key_id || header.recipient_key_id != recipient.key_id {
            return Err(MessageV2Error::InvalidHeader);
        }
        let aad = canonical_header(&header)?;
        let recipient_hpke = HpkePublicKey::from(decode(&recipient.hpke_public_key)?);
        let mut hpke = hpke();
        let (enc, ciphertext) = hpke
            .seal(
                &recipient_hpke,
                HPKE_INFO,
                &aad,
                plaintext,
                None,
                None,
                None,
            )
            .map_err(|_| MessageV2Error::EncryptFailed)?;
        if ciphertext.len() > MAX_CIPHERTEXT_BYTES {
            return Err(MessageV2Error::CiphertextTooLarge);
        }
        let signing_private = array_32(&decode(&self.signing_private_key)?)?;
        let signing = SigningKey::from_bytes(&signing_private);
        let signature = signing.sign(&signature_input(&aad, &enc, &ciphertext)?);
        Ok(MessageEnvelopeV2 {
            header,
            enc: URL_SAFE_NO_PAD.encode(enc),
            ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
            signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        })
    }

    pub fn open(
        &self,
        sender: &DevicePublicBundleV2,
        envelope: &MessageEnvelopeV2,
    ) -> Result<Vec<u8>, MessageV2Error> {
        self.validate()?;
        sender.validate()?;
        envelope.validate()?;
        if envelope.header.recipient_key_id != self.key_id
            || envelope.header.sender_key_id != sender.key_id
        {
            return Err(MessageV2Error::InvalidHeader);
        }
        let aad = canonical_header(&envelope.header)?;
        let enc = decode(&envelope.enc)?;
        let ciphertext = decode(&envelope.ciphertext)?;
        let signature = Signature::from_slice(&decode(&envelope.signature)?)
            .map_err(|_| MessageV2Error::SignatureInvalid)?;
        let verifying = VerifyingKey::from_bytes(&array_32(&decode(&sender.signing_public_key)?)?)
            .map_err(|_| MessageV2Error::InvalidKey)?;
        verifying
            .verify(&signature_input(&aad, &enc, &ciphertext)?, &signature)
            .map_err(|_| MessageV2Error::SignatureInvalid)?;
        let recipient_private = HpkePrivateKey::from(decode(&self.hpke_private_key)?);
        hpke()
            .open(
                &enc,
                &recipient_private,
                HPKE_INFO,
                &aad,
                &ciphertext,
                None,
                None,
                None,
            )
            .map_err(|_| MessageV2Error::DecryptFailed)
    }
}

impl DevicePublicBundleV2 {
    pub fn validate(&self) -> Result<(), MessageV2Error> {
        if self.version != E2EE_V2_PROTOCOL {
            return Err(MessageV2Error::Unsupported);
        }
        let hpke_public = decode(&self.hpke_public_key)?;
        let signing_public = decode(&self.signing_public_key)?;
        if hpke_public.len() != 32 || signing_public.len() != 32 {
            return Err(MessageV2Error::InvalidKey);
        }
        if key_id(&hpke_public, &signing_public) != self.key_id {
            return Err(MessageV2Error::InvalidKey);
        }
        Ok(())
    }
}

impl MessageHeaderV2 {
    pub fn validate(&self) -> Result<(), MessageV2Error> {
        if self.version != E2EE_V2_PROTOCOL || self.suite != E2EE_V2_SUITE {
            return Err(MessageV2Error::Unsupported);
        }
        for value in [
            &self.message_id,
            &self.conversation_id,
            &self.channel_id,
            &self.agent_did,
            &self.sender_device_id,
            &self.sender_key_id,
            &self.recipient_device_id,
            &self.recipient_key_id,
        ] {
            validate_field(value)?;
        }
        if self.created_at_ms == 0 {
            return Err(MessageV2Error::InvalidHeader);
        }
        Ok(())
    }
}

impl MessageEnvelopeV2 {
    pub fn validate(&self) -> Result<(), MessageV2Error> {
        self.header.validate()?;
        let enc = decode(&self.enc)?;
        let ciphertext = decode(&self.ciphertext)?;
        let signature = decode(&self.signature)?;
        if enc.len() != 32 || ciphertext.is_empty() || signature.len() != 64 {
            return Err(MessageV2Error::InvalidEncoding);
        }
        if ciphertext.len() > MAX_CIPHERTEXT_BYTES {
            return Err(MessageV2Error::CiphertextTooLarge);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(
        sender: &DevicePrivateBundleV2,
        recipient: &DevicePrivateBundleV2,
        message: &str,
    ) -> MessageHeaderV2 {
        MessageHeaderV2 {
            version: E2EE_V2_PROTOCOL.into(),
            suite: E2EE_V2_SUITE.into(),
            message_id: message.into(),
            conversation_id: "conversation-1".into(),
            channel_id: "visitor-1".into(),
            agent_did: "did:wba:vokovoko.com:agent-1".into(),
            sender_device_id: "browser-device-1".into(),
            sender_key_id: sender.key_id.clone(),
            recipient_device_id: "lite-device-1".into(),
            recipient_key_id: recipient.key_id.clone(),
            created_at_ms: 1_780_000_000_000,
            content_kind: MessageContentKindV2::Text,
        }
    }

    #[test]
    fn independent_messages_round_trip_in_any_order() {
        let sender = DevicePrivateBundleV2::generate().unwrap();
        let recipient = DevicePrivateBundleV2::generate().unwrap();
        let recipient_public = recipient.public_bundle().unwrap();
        let sender_public = sender.public_bundle().unwrap();
        let first = sender
            .seal(
                &recipient_public,
                header(&sender, &recipient, "message-1"),
                b"first",
            )
            .unwrap();
        let second = sender
            .seal(
                &recipient_public,
                header(&sender, &recipient, "message-2"),
                b"second",
            )
            .unwrap();
        assert_eq!(recipient.open(&sender_public, &second).unwrap(), b"second");
        assert_eq!(recipient.open(&sender_public, &first).unwrap(), b"first");
        assert_ne!(first.enc, second.enc);
    }

    #[test]
    fn route_ciphertext_and_signature_tampering_fail_closed() {
        let sender = DevicePrivateBundleV2::generate().unwrap();
        let recipient = DevicePrivateBundleV2::generate().unwrap();
        let recipient_public = recipient.public_bundle().unwrap();
        let sender_public = sender.public_bundle().unwrap();
        let envelope = sender
            .seal(
                &recipient_public,
                header(&sender, &recipient, "message-1"),
                b"secret",
            )
            .unwrap();

        let mut route = envelope.clone();
        route.header.conversation_id = "conversation-2".into();
        assert_eq!(
            recipient.open(&sender_public, &route),
            Err(MessageV2Error::SignatureInvalid)
        );

        let mut ciphertext = envelope.clone();
        let mut bytes = decode(&ciphertext.ciphertext).unwrap();
        bytes[0] ^= 1;
        ciphertext.ciphertext = URL_SAFE_NO_PAD.encode(bytes);
        assert_eq!(
            recipient.open(&sender_public, &ciphertext),
            Err(MessageV2Error::SignatureInvalid)
        );

        let mut signature = envelope;
        let mut bytes = decode(&signature.signature).unwrap();
        bytes[0] ^= 1;
        signature.signature = URL_SAFE_NO_PAD.encode(bytes);
        assert_eq!(
            recipient.open(&sender_public, &signature),
            Err(MessageV2Error::SignatureInvalid)
        );
    }

    #[test]
    fn wrong_recipient_and_unknown_fields_are_rejected() {
        let sender = DevicePrivateBundleV2::generate().unwrap();
        let recipient = DevicePrivateBundleV2::generate().unwrap();
        let other = DevicePrivateBundleV2::generate().unwrap();
        let envelope = sender
            .seal(
                &recipient.public_bundle().unwrap(),
                header(&sender, &recipient, "message-1"),
                b"secret",
            )
            .unwrap();
        assert_eq!(
            other.open(&sender.public_bundle().unwrap(), &envelope),
            Err(MessageV2Error::InvalidHeader)
        );

        let json = serde_json::to_string(&envelope).unwrap();
        let tampered = json.replacen('{', "{\"unknown\":true,", 1);
        assert!(serde_json::from_str::<MessageEnvelopeV2>(&tampered).is_err());
    }
}
