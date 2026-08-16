use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use voko_e2ee_core::{
    CanonicalAad, DeviceCredentialIdentity, DeviceRole, DirectGroup, DirectGroupPair,
    KeyPackageLedger, E2EE_CONTENT_TYPE, E2EE_PROTOCOL_VERSION,
};
use wasm_bindgen::prelude::*;

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
