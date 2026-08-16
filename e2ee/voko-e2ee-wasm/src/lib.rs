use voko_e2ee_core::{
    CanonicalAad, DeviceCredentialIdentity, DeviceRole, DirectGroupPair, KeyPackageLedger,
    E2EE_CONTENT_TYPE, E2EE_PROTOCOL_VERSION,
};
use wasm_bindgen::prelude::*;

/// Browser-executable feasibility wrapper. It deliberately owns both endpoints
/// and is therefore not a production transport API.
#[wasm_bindgen]
pub struct WasmDirectPoc {
    pair: DirectGroupPair,
    group_id: Vec<u8>,
    target_agent_did: Vec<u8>,
    sequence: u64,
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
            pair,
            group_id,
            target_agent_did,
            sequence: 0,
        })
    }

    pub fn round_trip(&mut self, plaintext: String) -> Result<String, JsError> {
        self.sequence += 1;
        let aad = CanonicalAad {
            protocol_version: E2EE_PROTOCOL_VERSION,
            content_type: E2EE_CONTENT_TYPE,
            group_id: self.group_id.clone(),
            epoch: 1,
            target_agent_did: self.target_agent_did.clone(),
            conversation_scope: b"wasm-test-conversation".to_vec(),
            sender_device_key_id: b"wasm-browser-key".to_vec(),
            message_id: format!("wasm-message-{}", self.sequence).into_bytes(),
            channel_type: 1,
        };
        let ciphertext = self
            .pair
            .creator
            .encrypt(&aad, plaintext.as_bytes())
            .map_err(|error| JsError::new(&error.to_string()))?;
        let decrypted = self
            .pair
            .recipient
            .decrypt(&aad, &ciphertext)
            .map_err(|error| JsError::new(&error.to_string()))?;
        String::from_utf8(decrypted).map_err(|_| JsError::new("decrypted text is not UTF-8"))
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
