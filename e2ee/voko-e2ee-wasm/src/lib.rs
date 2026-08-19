use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use voko_e2ee_core::{
    CanonicalAad, DeviceCredentialIdentity, DeviceRole, DirectCreatorEndpoint, DirectGroup,
    DirectGroupPair, KeyPackageLedger, E2EE_CONTENT_TYPE, E2EE_PROTOCOL_VERSION,
};
use wasm_bindgen::prelude::*;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;

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

fn required_bytes(value: String, name: &str) -> Result<Vec<u8>, JsError> {
    if value.is_empty() || value.len() > 2048 || value.chars().any(char::is_control) {
        return Err(JsError::new(&format!("invalid {name}")));
    }
    Ok(value.into_bytes())
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
            .decrypt(&route, &ciphertext).map_err(|error| JsError::new(&error.to_string()))?;
        String::from_utf8(plaintext).map_err(|_| JsError::new("decrypted message is not UTF-8"))
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
