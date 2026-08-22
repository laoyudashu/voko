use std::io::{self, BufRead, Write};

use serde::{Deserialize, Serialize};
use voko_e2ee_core::{
    CanonicalAad, DeviceCredentialIdentity, DeviceRole, DirectGroupPair, KeyPackageLedger,
    WireEnvelope, E2EE_CONTENT_TYPE, E2EE_PROTOCOL_VERSION,
};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    BrowserEncrypt { message_id: String, text: String },
    LiteDecrypt { envelope: WireEnvelope },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    envelope: Option<WireEnvelope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn identity(role: DeviceRole, key: &[u8]) -> DeviceCredentialIdentity {
    DeviceCredentialIdentity {
        role,
        principal_id: b"relay-test-principal".to_vec(),
        device_key_id: key.to_vec(),
        key_epoch: 1,
        target_agent_did: b"did:voko:relay-test-agent".to_vec(),
    }
}

fn main() {
    let mut pair = DirectGroupPair::establish_bound(
        b"relay-test-group",
        &identity(DeviceRole::Browser, b"relay-browser-key"),
        &identity(DeviceRole::OwnerDevice, b"relay-owner-key"),
        &mut KeyPackageLedger::default(),
    )
    .expect("failed to establish relay PoC group");

    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let response = match line {
            Ok(line) => match serde_json::from_str::<Command>(&line) {
                Ok(Command::BrowserEncrypt { message_id, text }) => {
                    let aad = CanonicalAad {
                        protocol_version: E2EE_PROTOCOL_VERSION,
                        content_type: E2EE_CONTENT_TYPE,
                        group_id: b"relay-test-group".to_vec(),
                        epoch: 1,
                        target_agent_did: b"did:voko:relay-test-agent".to_vec(),
                        conversation_scope: b"relay-test-conversation".to_vec(),
                        sender_device_key_id: b"relay-browser-key".to_vec(),
                        message_id: message_id.into_bytes(),
                        channel_type: 1,
                    };
                    pair.creator
                        .encrypt(&aad, text.as_bytes())
                        .and_then(|ciphertext| {
                            WireEnvelope::new(&aad, &ciphertext).map_err(|error| {
                                voko_e2ee_core::DirectGroupError::Mls(error.to_string())
                            })
                        })
                        .map(|envelope| Response {
                            success: true,
                            envelope: Some(envelope),
                            text: None,
                            error: None,
                        })
                        .unwrap_or_else(|error| failure(error.to_string()))
                }
                Ok(Command::LiteDecrypt { envelope }) => envelope
                    .aad()
                    .and_then(|aad| {
                        envelope
                            .ciphertext_bytes()
                            .map(|ciphertext| (aad, ciphertext))
                    })
                    .map_err(|error| error.to_string())
                    .and_then(|(aad, ciphertext)| {
                        pair.recipient
                            .decrypt(&aad, &ciphertext)
                            .map_err(|error| error.to_string())
                    })
                    .and_then(|plaintext| {
                        String::from_utf8(plaintext)
                            .map_err(|_| "plaintext is not UTF-8".to_string())
                    })
                    .map(|text| Response {
                        success: true,
                        envelope: None,
                        text: Some(text),
                        error: None,
                    })
                    .unwrap_or_else(failure),
                Err(error) => failure(format!("invalid command: {error}")),
            },
            Err(error) => failure(format!("input error: {error}")),
        };
        serde_json::to_writer(&mut stdout, &response).expect("failed to write JSON response");
        writeln!(stdout).expect("failed to terminate JSON response");
        stdout.flush().expect("failed to flush response");
    }
}

fn failure(error: String) -> Response {
    Response {
        success: false,
        envelope: None,
        text: None,
        error: Some(error),
    }
}
