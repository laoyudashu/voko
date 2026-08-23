use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use voko_e2ee_core::{
    AttachmentKey, CanonicalAad, DeviceCredentialIdentity, DeviceRole, DirectCreatorEndpoint,
    DevicePrivateBundleV2, DevicePublicBundleV2, DirectGroup, DirectGroupError, DirectGroupPair,
    DirectRecipientEndpoint, EncryptedAttachment, KeyPackageLedger, MessageEnvelopeV2,
    MessageHeaderV2, E2EE_CONTENT_TYPE, E2EE_PROTOCOL_VERSION,
};
use wasm_bindgen::prelude::*;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// Stateless per-message HPKE endpoint used by the production browser data
/// plane. Persist `private_bundle_json()` only inside the browser's encrypted
/// device vault; AgentDID receives only `public_bundle_json()`.
#[wasm_bindgen]
pub struct WasmMessageV2 {
    bundle: DevicePrivateBundleV2,
}

#[wasm_bindgen]
impl WasmMessageV2 {
    #[wasm_bindgen(js_name = generate)]
    pub fn generate() -> Result<WasmMessageV2, JsError> {
        Ok(Self {
            bundle: DevicePrivateBundleV2::generate()
                .map_err(|error| JsError::new(&error.to_string()))?,
        })
    }

    #[wasm_bindgen(js_name = fromPrivateBundle)]
    pub fn from_private_bundle(bundle_json: String) -> Result<WasmMessageV2, JsError> {
        let bundle: DevicePrivateBundleV2 = serde_json::from_str(&bundle_json)
            .map_err(|_| JsError::new("invalid E2EE v2 private bundle"))?;
        bundle
            .validate()
            .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(Self { bundle })
    }

    pub fn private_bundle_json(&self) -> Result<String, JsError> {
        serde_json::to_string(&self.bundle).map_err(|error| JsError::new(&error.to_string()))
    }

    pub fn public_bundle_json(&self) -> Result<String, JsError> {
        let public = self
            .bundle
            .public_bundle()
            .map_err(|error| JsError::new(&error.to_string()))?;
        serde_json::to_string(&public).map_err(|error| JsError::new(&error.to_string()))
    }

    pub fn seal(
        &self,
        recipient_public_json: String,
        header_json: String,
        plaintext: &[u8],
    ) -> Result<String, JsError> {
        let recipient: DevicePublicBundleV2 = serde_json::from_str(&recipient_public_json)
            .map_err(|_| JsError::new("invalid E2EE v2 public bundle"))?;
        let header: MessageHeaderV2 = serde_json::from_str(&header_json)
            .map_err(|_| JsError::new("invalid E2EE v2 header"))?;
        let envelope = self
            .bundle
            .seal(&recipient, header, plaintext)
            .map_err(|error| JsError::new(&error.to_string()))?;
        serde_json::to_string(&envelope).map_err(|error| JsError::new(&error.to_string()))
    }

    pub fn open(
        &self,
        sender_public_json: String,
        envelope_json: String,
    ) -> Result<Vec<u8>, JsError> {
        let sender: DevicePublicBundleV2 = serde_json::from_str(&sender_public_json)
            .map_err(|_| JsError::new("invalid E2EE v2 public bundle"))?;
        let envelope: MessageEnvelopeV2 = serde_json::from_str(&envelope_json)
            .map_err(|_| JsError::new("invalid E2EE v2 envelope"))?;
        self.bundle
            .open(&sender, &envelope)
            .map_err(|error| JsError::new(&error.to_string()))
    }
}

/// Browser-executable feasibility wrapper. It deliberately owns both endpoints
/// and is therefore not a production transport API.
#[wasm_bindgen]
pub struct WasmDirectPoc {
    creator: DirectGroup,
    recipient: DirectGroup,
    group_id: Vec<u8>,
    target_agent_did: Vec<u8>,
    sequence: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WasmStateSnapshot {
    version: u16,
    creator: String,
    recipient: String,
    group_id: String,
    target_agent_did: String,
    sequence: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WasmPreparedRecord {
    message_id: String,
    ciphertext: String,
    state_snapshot: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WasmPreparedAdd {
    commit: String,
    welcome: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WasmEncryptedAttachment {
    version: String,
    file_id: String,
    nonce_prefix: String,
    plaintext_size: u64,
    chunk_size: u32,
    ciphertext_hashes: Vec<String>,
    chunks: Vec<String>,
    key: String,
}

/// Browser-side endpoint used by the cross-process canary. Recipient private
/// KeyPackage material is never present in this WASM instance.
#[wasm_bindgen]
pub struct WasmCreatorEndpoint {
    pending: Option<DirectCreatorEndpoint>,
    group: Option<DirectGroup>,
    group_id: Vec<u8>,
    target_agent_did: Vec<u8>,
}

/// Production browser endpoint. Unlike the cross-process Canary wrapper, all
/// authenticated routing inputs are supplied by the caller and become MLS AAD.
/// The active group snapshot is exported for encrypted IndexedDB persistence.
#[wasm_bindgen]
pub struct WasmBrowserEndpoint {
    pending: Option<DirectCreatorEndpoint>,
    group: Option<DirectGroup>,
    group_id: Vec<u8>,
    target_agent_did: Vec<u8>,
    conversation_scope: Vec<u8>,
    sender_device_key_id: Vec<u8>,
}

/// Independent browser device joining an existing MLS conversation. The
/// pending KeyPackage snapshot and active group snapshot are persisted only by
/// that browser's encrypted IndexedDB vault.
#[wasm_bindgen]
pub struct WasmBrowserMemberEndpoint {
    pending: Option<DirectRecipientEndpoint>,
    group: Option<DirectGroup>,
    group_id: Vec<u8>,
    target_agent_did: Vec<u8>,
    conversation_scope: Vec<u8>,
    sender_device_key_id: Vec<u8>,
}

fn required_bytes(value: String, name: &str) -> Result<Vec<u8>, JsError> {
    if value.is_empty() || value.len() > 2048 || value.chars().any(char::is_control) {
        return Err(JsError::new(&format!("invalid {name}")));
    }
    Ok(value.into_bytes())
}

fn stable_decrypt_error(error: DirectGroupError) -> JsError {
    JsError::new(stable_decrypt_error_code(&error))
}

fn stable_decrypt_error_code(error: &DirectGroupError) -> &'static str {
    let detail = error.to_string().to_ascii_lowercase();
    if detail.contains("secretreuse") || detail.contains("too distant in the past") {
        "E2EE_RATCHET_PAST_OR_REUSED"
    } else if detail.contains("generationoutofbound") || detail.contains("too distant in the future") {
        "E2EE_RATCHET_FUTURE_OR_MISSING"
    } else if detail.contains("aead") || detail.contains("authentication") {
        "E2EE_CIPHERTEXT_AUTH_FAILED"
    } else if detail.contains("routing mismatch") || detail.contains("route scope") {
        "E2EE_AAD_MISMATCH"
    } else {
        "E2EE_CRYPTO_DECRYPT_FAILED"
    }
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
enum CheckedDecryptResult {
    Ok { plaintext: String },
    Error { code: &'static str },
}

#[wasm_bindgen]
impl WasmBrowserEndpoint {
    #[wasm_bindgen(constructor)]
    pub fn new(
        principal_id: String,
        device_key_id: String,
        key_epoch: u32,
        target_agent_did: String,
        group_id: String,
        conversation_scope: String,
    ) -> Result<Self, JsError> {
        if key_epoch == 0 { return Err(JsError::new("invalid key epoch")); }
        let identity = DeviceCredentialIdentity {
            role: DeviceRole::Browser,
            principal_id: required_bytes(principal_id, "principal ID")?,
            device_key_id: required_bytes(device_key_id.clone(), "device key ID")?,
            key_epoch: u64::from(key_epoch),
            target_agent_did: required_bytes(target_agent_did.clone(), "target Agent DID")?,
        };
        let group_id = required_bytes(group_id, "group ID")?;
        let pending = DirectCreatorEndpoint::new(&group_id, &identity)
            .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(Self {
            pending: Some(pending), group: None, group_id,
            target_agent_did: target_agent_did.into_bytes(),
            conversation_scope: required_bytes(conversation_scope, "conversation scope")?,
            sender_device_key_id: device_key_id.into_bytes(),
        })
    }

    pub fn prepare_add(&mut self, key_package: String) -> Result<String, JsError> {
        let package = URL_SAFE_NO_PAD.decode(key_package)
            .map_err(|_| JsError::new("invalid KeyPackage encoding"))?;
        let prepared = self.pending.as_mut().ok_or_else(|| JsError::new("creator is not pending"))?
            .prepare_add(&package).map_err(|error| JsError::new(&error.to_string()))?;
        serde_json::to_string(&WasmPreparedAdd {
            commit: URL_SAFE_NO_PAD.encode(prepared.commit),
            welcome: URL_SAFE_NO_PAD.encode(prepared.welcome),
        }).map_err(|error| JsError::new(&error.to_string()))
    }

    pub fn accept_add(&mut self) -> Result<(), JsError> {
        let pending = self.pending.take().ok_or_else(|| JsError::new("creator is not pending"))?;
        self.group = Some(pending.accept_add().map_err(|error| JsError::new(&error.to_string()))?);
        Ok(())
    }

    pub fn encrypt_message(&mut self, message_id: String, plaintext: String) -> Result<String, JsError> {
        let active = self.group.as_mut().ok_or_else(|| JsError::new("group is not active"))?;
        let route = CanonicalAad {
            protocol_version: E2EE_PROTOCOL_VERSION, content_type: E2EE_CONTENT_TYPE,
            group_id: self.group_id.clone(), epoch: active.epoch(),
            target_agent_did: self.target_agent_did.clone(),
            conversation_scope: self.conversation_scope.clone(),
            sender_device_key_id: self.sender_device_key_id.clone(),
            message_id: required_bytes(message_id, "message ID")?, channel_type: 1,
        };
        let ciphertext = active.encrypt(&route, plaintext.as_bytes())
            .map_err(|error| JsError::new(&error.to_string()))?;
        let envelope = voko_e2ee_core::WireEnvelope::new(&route, &ciphertext)
            .map_err(|error| JsError::new(&error.to_string()))?;
        serde_json::to_string(&envelope).map_err(|error| JsError::new(&error.to_string()))
    }

    pub fn decrypt_message(&mut self, envelope_json: String) -> Result<String, JsError> {
        let envelope: voko_e2ee_core::WireEnvelope = serde_json::from_str(&envelope_json)
            .map_err(|_| JsError::new("invalid E2EE envelope"))?;
        let route = envelope.aad().map_err(|error| JsError::new(&error.to_string()))?;
        if route.group_id != self.group_id || route.target_agent_did != self.target_agent_did
            || route.conversation_scope != self.conversation_scope {
            return Err(JsError::new("authenticated route scope mismatch"));
        }
        let ciphertext = envelope.ciphertext_bytes().map_err(|error| JsError::new(&error.to_string()))?;
        let plaintext = self.group.as_mut().ok_or_else(|| JsError::new("group is not active"))?
            .decrypt(&route, &ciphertext).map_err(stable_decrypt_error)?;
        String::from_utf8(plaintext).map_err(|_| JsError::new("decrypted message is not UTF-8"))
    }

    /// Decrypts without relying on wasm-bindgen's exception conversion. Some
    /// embedded browsers collapse a Rust JsError into a generic `Error`, which
    /// hides the stable ratchet/authentication code needed for safe recovery.
    /// The result never includes ciphertext, key material, or MLS internals.
    pub fn decrypt_message_checked(&mut self, envelope_json: String) -> String {
        let checked = (|| -> Result<String, &'static str> {
            let envelope: voko_e2ee_core::WireEnvelope = serde_json::from_str(&envelope_json)
                .map_err(|_| "E2EE_ENVELOPE_INVALID")?;
            let route = envelope.aad().map_err(|_| "E2EE_ENVELOPE_INVALID")?;
            if route.group_id != self.group_id || route.target_agent_did != self.target_agent_did
                || route.conversation_scope != self.conversation_scope {
                return Err("E2EE_AAD_MISMATCH");
            }
            let ciphertext = envelope.ciphertext_bytes().map_err(|_| "E2EE_ENVELOPE_INVALID")?;
            let plaintext = self.group.as_mut().ok_or("E2EE_GROUP_NOT_ACTIVE")?
                .decrypt(&route, &ciphertext).map_err(|error| stable_decrypt_error_code(&error))?;
            String::from_utf8(plaintext).map_err(|_| "E2EE_PLAINTEXT_ENCODING_INVALID")
        })();
        let result = match checked {
            Ok(plaintext) => CheckedDecryptResult::Ok { plaintext },
            Err(code) => CheckedDecryptResult::Error { code },
        };
        serde_json::to_string(&result).expect("checked decrypt result is serializable")
    }

    pub fn snapshot(&self) -> Result<String, JsError> {
        let bytes = self.group.as_ref().ok_or_else(|| JsError::new("group is not active"))?
            .snapshot().map_err(|error| JsError::new(&error.to_string()))?;
        Ok(URL_SAFE_NO_PAD.encode(bytes))
    }

    pub fn restore(&mut self, snapshot: String) -> Result<(), JsError> {
        let bytes = URL_SAFE_NO_PAD.decode(snapshot).map_err(|_| JsError::new("invalid group snapshot"))?;
        self.group = Some(DirectGroup::restore(&bytes).map_err(|error| JsError::new(&error.to_string()))?);
        self.pending = None;
        Ok(())
    }

    pub fn prepare_add_member(&mut self, key_package: String) -> Result<String, JsError> {
        let package = URL_SAFE_NO_PAD.decode(key_package).map_err(|_| JsError::new("invalid KeyPackage encoding"))?;
        let prepared = self.group.as_mut().ok_or_else(|| JsError::new("group is not active"))?
            .prepare_add_member(&package).map_err(|error| JsError::new(&error.to_string()))?;
        serde_json::to_string(&WasmPreparedAdd { commit: URL_SAFE_NO_PAD.encode(prepared.commit),
            welcome: URL_SAFE_NO_PAD.encode(prepared.welcome) }).map_err(|error| JsError::new(&error.to_string()))
    }
    pub fn prepare_remove_device(&mut self, device_key_id:String)->Result<String,JsError>{
        let commit=self.group.as_mut().ok_or_else(||JsError::new("group is not active"))?
            .prepare_remove_device(&required_bytes(device_key_id,"device key ID")?).map_err(|e|JsError::new(&e.to_string()))?;
        Ok(URL_SAFE_NO_PAD.encode(commit))
    }

    pub fn accept_pending_commit(&mut self) -> Result<(), JsError> {
        self.group.as_mut().ok_or_else(|| JsError::new("group is not active"))?
            .accept_pending_commit().map_err(|error| JsError::new(&error.to_string()))
    }

    pub fn apply_commit(&mut self, commit: String) -> Result<(), JsError> {
        let bytes = URL_SAFE_NO_PAD.decode(commit).map_err(|_| JsError::new("invalid Commit encoding"))?;
        self.group.as_mut().ok_or_else(|| JsError::new("group is not active"))?
            .apply_commit(&bytes).map_err(|error| JsError::new(&error.to_string()))
    }

    pub fn epoch(&self) -> Result<u32, JsError> {
        let epoch = self.group.as_ref().ok_or_else(|| JsError::new("group is not active"))?.epoch();
        u32::try_from(epoch).map_err(|_| JsError::new("epoch exceeds browser range"))
    }

    /// Returns ciphertext chunks plus a per-file key. The caller MUST place
    /// the key-bearing manifest only inside an authenticated MLS message.
    pub fn encrypt_attachment(&self, plaintext: Vec<u8>) -> Result<String, JsError> {
        let key = AttachmentKey::generate();
        let encrypted = EncryptedAttachment::encrypt(&plaintext, &key)
            .map_err(|error| JsError::new(&error.to_string()))?;
        serde_json::to_string(&WasmEncryptedAttachment {
            version: "voko.e2ee.attachment/1".into(),
            file_id: URL_SAFE_NO_PAD.encode(encrypted.file_id),
            nonce_prefix: URL_SAFE_NO_PAD.encode(encrypted.nonce_prefix),
            plaintext_size: encrypted.plaintext_size,
            chunk_size: encrypted.chunk_size,
            ciphertext_hashes: encrypted.ciphertext_hashes.iter().map(|value| URL_SAFE_NO_PAD.encode(value)).collect(),
            chunks: encrypted.chunks.iter().map(|value| URL_SAFE_NO_PAD.encode(value)).collect(),
            key: URL_SAFE_NO_PAD.encode(key.expose_for_mls()),
        }).map_err(|error| JsError::new(&error.to_string()))
    }

    pub fn decrypt_attachment(&self, package_json: String) -> Result<Vec<u8>, JsError> {
        let package: WasmEncryptedAttachment = serde_json::from_str(&package_json)
            .map_err(|_| JsError::new("invalid encrypted attachment"))?;
        if package.version != "voko.e2ee.attachment/1" {
            return Err(JsError::new("invalid encrypted attachment version"));
        }
        let file_id: [u8; 16] = URL_SAFE_NO_PAD.decode(package.file_id).map_err(|_| JsError::new("invalid file ID"))?
            .try_into().map_err(|_| JsError::new("invalid file ID"))?;
        let nonce_prefix: [u8; 8] = URL_SAFE_NO_PAD.decode(package.nonce_prefix).map_err(|_| JsError::new("invalid nonce"))?
            .try_into().map_err(|_| JsError::new("invalid nonce"))?;
        let key = AttachmentKey::from_bytes(&URL_SAFE_NO_PAD.decode(package.key).map_err(|_| JsError::new("invalid attachment key"))?)
            .map_err(|error| JsError::new(&error.to_string()))?;
        let hashes = package.ciphertext_hashes.into_iter().map(|value| {
            URL_SAFE_NO_PAD.decode(value).map_err(|_| JsError::new("invalid ciphertext hash"))?
                .try_into().map_err(|_| JsError::new("invalid ciphertext hash"))
        }).collect::<Result<Vec<[u8; 32]>, JsError>>()?;
        let chunks = package.chunks.into_iter().map(|value| URL_SAFE_NO_PAD.decode(value)
            .map_err(|_| JsError::new("invalid ciphertext chunk"))).collect::<Result<Vec<_>,_>>()?;
        let encrypted = EncryptedAttachment { file_id, nonce_prefix, plaintext_size:package.plaintext_size,
            chunk_size:package.chunk_size, ciphertext_hashes:hashes, chunks };
        encrypted.decrypt(&key).map(|value| value.to_vec()).map_err(|error| JsError::new(&error.to_string()))
    }
}

#[wasm_bindgen]
impl WasmBrowserMemberEndpoint {
    #[wasm_bindgen(constructor)]
    pub fn new(principal_id: String, device_key_id: String, key_epoch: u32,
        target_agent_did: String, group_id: String, conversation_scope: String) -> Result<Self, JsError> {
        if key_epoch == 0 { return Err(JsError::new("invalid key epoch")); }
        let identity = DeviceCredentialIdentity { role: DeviceRole::Browser,
            principal_id: required_bytes(principal_id, "principal ID")?,
            device_key_id: required_bytes(device_key_id.clone(), "device key ID")?, key_epoch:u64::from(key_epoch),
            target_agent_did: required_bytes(target_agent_did.clone(), "target Agent DID")? };
        Ok(Self { pending:Some(DirectRecipientEndpoint::new(&identity).map_err(|e| JsError::new(&e.to_string()))?),
            group:None, group_id:required_bytes(group_id,"group ID")?, target_agent_did:target_agent_did.into_bytes(),
            conversation_scope:required_bytes(conversation_scope,"conversation scope")?, sender_device_key_id:device_key_id.into_bytes() })
    }

    pub fn key_package(&self) -> Result<String, JsError> {
        Ok(URL_SAFE_NO_PAD.encode(self.pending.as_ref().ok_or_else(|| JsError::new("member is not pending"))?.serialized_key_package()))
    }
    pub fn pending_snapshot(&self) -> Result<String, JsError> {
        Ok(URL_SAFE_NO_PAD.encode(self.pending.as_ref().ok_or_else(|| JsError::new("member is not pending"))?
            .snapshot().map_err(|e| JsError::new(&e.to_string()))?))
    }
    pub fn restore_pending(&mut self, snapshot: String) -> Result<(), JsError> {
        let bytes=URL_SAFE_NO_PAD.decode(snapshot).map_err(|_| JsError::new("invalid pending snapshot"))?;
        self.pending=Some(DirectRecipientEndpoint::restore(&bytes).map_err(|e| JsError::new(&e.to_string()))?); self.group=None; Ok(())
    }
    pub fn join(&mut self, welcome: String) -> Result<(), JsError> {
        let bytes=URL_SAFE_NO_PAD.decode(welcome).map_err(|_| JsError::new("invalid Welcome encoding"))?;
        let pending=self.pending.take().ok_or_else(|| JsError::new("member is not pending"))?;
        self.group=Some(pending.join(&bytes).map_err(|e| JsError::new(&e.to_string()))?); Ok(())
    }
    pub fn snapshot(&self) -> Result<String, JsError> {
        Ok(URL_SAFE_NO_PAD.encode(self.group.as_ref().ok_or_else(|| JsError::new("group is not active"))?
            .snapshot().map_err(|e| JsError::new(&e.to_string()))?))
    }
    pub fn restore(&mut self, snapshot: String) -> Result<(), JsError> {
        let bytes=URL_SAFE_NO_PAD.decode(snapshot).map_err(|_| JsError::new("invalid group snapshot"))?;
        self.group=Some(DirectGroup::restore(&bytes).map_err(|e| JsError::new(&e.to_string()))?); self.pending=None; Ok(())
    }
    pub fn apply_commit(&mut self, commit: String) -> Result<(), JsError> {
        let bytes=URL_SAFE_NO_PAD.decode(commit).map_err(|_| JsError::new("invalid Commit encoding"))?;
        self.group.as_mut().ok_or_else(|| JsError::new("group is not active"))?.apply_commit(&bytes)
            .map_err(|e| JsError::new(&e.to_string()))
    }
    pub fn prepare_remove_device(&mut self,device_key_id:String)->Result<String,JsError>{
        let commit=self.group.as_mut().ok_or_else(||JsError::new("group is not active"))?
          .prepare_remove_device(&required_bytes(device_key_id,"device key ID")?).map_err(|e|JsError::new(&e.to_string()))?;
        Ok(URL_SAFE_NO_PAD.encode(commit))
    }
    pub fn epoch(&self) -> Result<u32, JsError> {
        u32::try_from(self.group.as_ref().ok_or_else(|| JsError::new("group is not active"))?.epoch())
            .map_err(|_| JsError::new("epoch exceeds browser range"))
    }
    pub fn encrypt_message(&mut self, message_id:String, plaintext:String) -> Result<String,JsError> {
        let active=self.group.as_mut().ok_or_else(|| JsError::new("group is not active"))?;
        let route=CanonicalAad { protocol_version:E2EE_PROTOCOL_VERSION,content_type:E2EE_CONTENT_TYPE,
            group_id:self.group_id.clone(),epoch:active.epoch(),target_agent_did:self.target_agent_did.clone(),
            conversation_scope:self.conversation_scope.clone(),sender_device_key_id:self.sender_device_key_id.clone(),
            message_id:required_bytes(message_id,"message ID")?,channel_type:1 };
        let ciphertext=active.encrypt(&route,plaintext.as_bytes()).map_err(|e| JsError::new(&e.to_string()))?;
        serde_json::to_string(&voko_e2ee_core::WireEnvelope::new(&route,&ciphertext)
            .map_err(|e| JsError::new(&e.to_string()))?).map_err(|e| JsError::new(&e.to_string()))
    }
    pub fn decrypt_message(&mut self,envelope_json:String)->Result<String,JsError>{
        let envelope:voko_e2ee_core::WireEnvelope=serde_json::from_str(&envelope_json).map_err(|_|JsError::new("invalid E2EE envelope"))?;
        let route=envelope.aad().map_err(|e|JsError::new(&e.to_string()))?;
        if route.group_id!=self.group_id||route.target_agent_did!=self.target_agent_did||route.conversation_scope!=self.conversation_scope{return Err(JsError::new("authenticated route scope mismatch"));}
        let ciphertext=envelope.ciphertext_bytes().map_err(|e|JsError::new(&e.to_string()))?;
        String::from_utf8(self.group.as_mut().ok_or_else(||JsError::new("group is not active"))?.decrypt(&route,&ciphertext).map_err(stable_decrypt_error)?)
            .map_err(|_|JsError::new("decrypted message is not UTF-8"))
    }
}

#[wasm_bindgen]
impl WasmCreatorEndpoint {
    #[wasm_bindgen(constructor)]
    pub fn new(group_id: String, target_agent_did: String) -> Result<Self, JsError> {
        if group_id.is_empty() || target_agent_did.is_empty() {
            return Err(JsError::new("group ID and Agent DID are required"));
        }
        let identity = DeviceCredentialIdentity {
            role: DeviceRole::Browser,
            principal_id: b"cross-process-principal".to_vec(),
            device_key_id: b"cross-process-browser".to_vec(),
            key_epoch: 1,
            target_agent_did: target_agent_did.as_bytes().to_vec(),
        };
        let group_id_bytes = group_id.as_bytes().to_vec();
        let pending = DirectCreatorEndpoint::new(&group_id_bytes, &identity)
            .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(Self { pending: Some(pending), group: None, group_id: group_id_bytes, target_agent_did: target_agent_did.into_bytes() })
    }

    pub fn prepare_add(&mut self, key_package: String) -> Result<String, JsError> {
        let package = STANDARD_NO_PAD.decode(key_package)
            .map_err(|_| JsError::new("invalid KeyPackage encoding"))?;
        let prepared = self.pending.as_mut().ok_or_else(|| JsError::new("creator is not pending"))?
            .prepare_add(&package).map_err(|error| JsError::new(&error.to_string()))?;
        serde_json::to_string(&WasmPreparedAdd {
            commit: STANDARD_NO_PAD.encode(prepared.commit),
            welcome: STANDARD_NO_PAD.encode(prepared.welcome),
        }).map_err(|error| JsError::new(&error.to_string()))
    }

    pub fn accept_add(&mut self) -> Result<(), JsError> {
        let pending = self.pending.take().ok_or_else(|| JsError::new("creator is not pending"))?;
        self.group = Some(pending.accept_add().map_err(|error| JsError::new(&error.to_string()))?);
        Ok(())
    }

    pub fn decrypt_ack(&mut self, ciphertext: String) -> Result<String, JsError> {
        self.decrypt(ciphertext, b"cross-process-owner", b"group-established-ack")
    }

    pub fn encrypt_message(&mut self, plaintext: String) -> Result<String, JsError> {
        let aad = self.aad(b"cross-process-browser", b"application-1")?;
        let ciphertext = self.group.as_mut().ok_or_else(|| JsError::new("group is not active"))?
            .encrypt(&aad, plaintext.as_bytes()).map_err(|error| JsError::new(&error.to_string()))?;
        Ok(STANDARD_NO_PAD.encode(ciphertext))
    }

    pub fn decrypt_reply(&mut self, ciphertext: String) -> Result<String, JsError> {
        self.decrypt(ciphertext, b"cross-process-owner", b"application-reply-1")
    }
}

impl WasmCreatorEndpoint {
    fn aad(&self, sender: &[u8], message: &[u8]) -> Result<CanonicalAad, JsError> {
        let epoch = self.group.as_ref().ok_or_else(|| JsError::new("group is not active"))?.epoch();
        Ok(CanonicalAad {
            protocol_version: E2EE_PROTOCOL_VERSION, content_type: E2EE_CONTENT_TYPE,
            group_id: self.group_id.clone(), epoch, target_agent_did: self.target_agent_did.clone(),
            conversation_scope: b"cross-process-conversation".to_vec(),
            sender_device_key_id: sender.to_vec(), message_id: message.to_vec(), channel_type: 1,
        })
    }

    fn decrypt(&mut self, ciphertext: String, sender: &[u8], message: &[u8]) -> Result<String, JsError> {
        let aad = self.aad(sender, message)?;
        let bytes = STANDARD_NO_PAD.decode(ciphertext).map_err(|_| JsError::new("invalid ciphertext encoding"))?;
        let plaintext = self.group.as_mut().ok_or_else(|| JsError::new("group is not active"))?
            .decrypt(&aad, &bytes).map_err(|error| JsError::new(&error.to_string()))?;
        String::from_utf8(plaintext).map_err(|_| JsError::new("decrypted ACK is not UTF-8"))
    }
}

#[wasm_bindgen]
impl WasmDirectPoc {
    #[wasm_bindgen(constructor)]
    pub fn new(group_id: String, target_agent_did: String) -> Result<Self, JsError> {
        if group_id.is_empty() || target_agent_did.is_empty() {
            return Err(JsError::new("group ID and Agent DID are required"));
        }
        let target_agent_did = target_agent_did.into_bytes();
        let creator = DeviceCredentialIdentity {
            role: DeviceRole::Browser,
            principal_id: b"wasm-test-principal".to_vec(),
            device_key_id: b"wasm-browser-key".to_vec(),
            key_epoch: 1,
            target_agent_did: target_agent_did.clone(),
        };
        let recipient = DeviceCredentialIdentity {
            role: DeviceRole::OwnerDevice,
            principal_id: b"wasm-owner-principal".to_vec(),
            device_key_id: b"wasm-owner-key".to_vec(),
            key_epoch: 1,
            target_agent_did: target_agent_did.clone(),
        };
        let group_id = group_id.into_bytes();
        let pair = DirectGroupPair::establish_bound(
            &group_id,
            &creator,
            &recipient,
            &mut KeyPackageLedger::default(),
        )
        .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(Self {
            creator: pair.creator,
            recipient: pair.recipient,
            group_id,
            target_agent_did,
            sequence: 0,
        })
    }

    pub fn round_trip(&mut self, plaintext: String) -> Result<String, JsError> {
        let prepared: WasmPreparedRecord =
            serde_json::from_str(&self.prepare_record(plaintext)?)
                .map_err(|error| JsError::new(&format!("parse prepared record: {error}")))?;
        self.decrypt_record(prepared.message_id, prepared.ciphertext)
    }

    pub fn prepare_record(&mut self, plaintext: String) -> Result<String, JsError> {
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or_else(|| JsError::new("WASM message sequence overflow"))?;
        let message_id = format!("wasm-message-{}", self.sequence);
        let aad = CanonicalAad {
            protocol_version: E2EE_PROTOCOL_VERSION,
            content_type: E2EE_CONTENT_TYPE,
            group_id: self.group_id.clone(),
            epoch: self.creator.epoch(),
            target_agent_did: self.target_agent_did.clone(),
            conversation_scope: b"wasm-test-conversation".to_vec(),
            sender_device_key_id: b"wasm-browser-key".to_vec(),
            message_id: message_id.as_bytes().to_vec(),
            channel_type: 1,
        };
        let ciphertext = self
            .creator
            .encrypt(&aad, plaintext.as_bytes())
            .map_err(|error| JsError::new(&error.to_string()))?;
        let prepared = WasmPreparedRecord {
            message_id,
            ciphertext: STANDARD_NO_PAD.encode(ciphertext),
            state_snapshot: self.snapshot()?,
        };
        serde_json::to_string(&prepared)
            .map_err(|error| JsError::new(&format!("serialize prepared record: {error}")))
    }

    pub fn decrypt_record(
        &mut self,
        message_id: String,
        ciphertext: String,
    ) -> Result<String, JsError> {
        let aad = CanonicalAad {
            protocol_version: E2EE_PROTOCOL_VERSION,
            content_type: E2EE_CONTENT_TYPE,
            group_id: self.group_id.clone(),
            epoch: self.recipient.epoch(),
            target_agent_did: self.target_agent_did.clone(),
            conversation_scope: b"wasm-test-conversation".to_vec(),
            sender_device_key_id: b"wasm-browser-key".to_vec(),
            message_id: message_id.into_bytes(),
            channel_type: 1,
        };
        let ciphertext = STANDARD_NO_PAD
            .decode(ciphertext)
            .map_err(|_| JsError::new("invalid WASM ciphertext"))?;
        let decrypted = self
            .recipient
            .decrypt(&aad, &ciphertext)
            .map_err(|error| JsError::new(&error.to_string()))?;
        String::from_utf8(decrypted).map_err(|_| JsError::new("decrypted text is not UTF-8"))
    }

    pub fn snapshot(&self) -> Result<String, JsError> {
        let snapshot = WasmStateSnapshot {
            version: 1,
            creator: STANDARD_NO_PAD.encode(
                self.creator
                    .snapshot()
                    .map_err(|error| JsError::new(&error.to_string()))?,
            ),
            recipient: STANDARD_NO_PAD.encode(
                self.recipient
                    .snapshot()
                    .map_err(|error| JsError::new(&error.to_string()))?,
            ),
            group_id: STANDARD_NO_PAD.encode(&self.group_id),
            target_agent_did: STANDARD_NO_PAD.encode(&self.target_agent_did),
            sequence: self.sequence,
        };
        serde_json::to_string(&snapshot)
            .map_err(|error| JsError::new(&format!("serialize WASM state: {error}")))
    }

    pub fn restore(snapshot: String) -> Result<Self, JsError> {
        let snapshot: WasmStateSnapshot = serde_json::from_str(&snapshot)
            .map_err(|error| JsError::new(&format!("parse WASM state: {error}")))?;
        if snapshot.version != 1 {
            return Err(JsError::new("unsupported WASM state version"));
        }
        let decode = |value: String| {
            STANDARD_NO_PAD
                .decode(value)
                .map_err(|_| JsError::new("invalid WASM state encoding"))
        };
        Ok(Self {
            creator: DirectGroup::restore(&decode(snapshot.creator)?)
                .map_err(|error| JsError::new(&error.to_string()))?,
            recipient: DirectGroup::restore(&decode(snapshot.recipient)?)
                .map_err(|error| JsError::new(&error.to_string()))?,
            group_id: decode(snapshot.group_id)?,
            target_agent_did: decode(snapshot.target_agent_did)?,
            sequence: snapshot.sequence,
        })
    }
}

#[cfg(all(test, target_arch = "wasm32"))]
mod tests {
    use super::*;
    use wasm_bindgen_test::*;
    use voko_e2ee_core::{
        MessageContentKindV2, MessageHeaderV2, E2EE_V2_PROTOCOL, E2EE_V2_SUITE,
    };

    #[wasm_bindgen_test]
    fn hpke_v2_round_trips_between_independent_endpoints() {
        let sender = WasmMessageV2::generate().unwrap();
        let recipient = WasmMessageV2::generate().unwrap();
        let sender_public: DevicePublicBundleV2 =
            serde_json::from_str(&sender.public_bundle_json().unwrap()).unwrap();
        let recipient_public: DevicePublicBundleV2 =
            serde_json::from_str(&recipient.public_bundle_json().unwrap()).unwrap();
        let header = MessageHeaderV2 {
            version: E2EE_V2_PROTOCOL.into(),
            suite: E2EE_V2_SUITE.into(),
            message_id: "wasm-message-1".into(),
            conversation_id: "conversation-1".into(),
            channel_id: "visitor-1".into(),
            agent_did: "did:wba:vokovoko.com:agent-1".into(),
            sender_device_id: "browser-1".into(),
            sender_key_id: sender_public.key_id,
            recipient_device_id: "lite-1".into(),
            recipient_key_id: recipient_public.key_id,
            created_at_ms: 1_780_000_000_000,
            content_kind: MessageContentKindV2::Text,
        };
        let envelope = sender
            .seal(
                recipient.public_bundle_json().unwrap(),
                serde_json::to_string(&header).unwrap(),
                b"hello from wasm",
            )
            .unwrap();
        assert_eq!(
            recipient
                .open(sender.public_bundle_json().unwrap(), envelope)
                .unwrap(),
            b"hello from wasm"
        );
    }

    #[wasm_bindgen_test]
    fn creates_group_and_round_trips_in_wasm() {
        let mut poc =
            WasmDirectPoc::new("wasm-group".into(), "did:voko:wasm-agent".into()).unwrap();
        assert_eq!(
            poc.round_trip("hello from wasm".into()).unwrap(),
            "hello from wasm"
        );
    }
}
