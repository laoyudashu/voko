use voko_e2ee_core::{DevicePrivateBundleV2, DevicePublicBundleV2, MessageEnvelopeV2, MessageHeaderV2};
use wasm_bindgen::prelude::*;

/// Stateless per-message endpoint shared by browsers and VOKO Lite.
/// Private bundles are endpoint-only; AgentDID receives public_bundle_json().
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

#[cfg(all(test, target_arch = "wasm32"))]
mod tests {
    use super::*;
    use voko_e2ee_core::{MessageContentKindV2, MessageHeaderV2, E2EE_V2_PROTOCOL, E2EE_V2_SUITE};
    use wasm_bindgen_test::*;

    #[wasm_bindgen_test]
    fn round_trips_between_independent_endpoints() {
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
}
