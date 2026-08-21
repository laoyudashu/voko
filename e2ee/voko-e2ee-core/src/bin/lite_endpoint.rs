use std::io::{self, BufRead, Write};

use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use voko_e2ee_core::{
    CanonicalAad, DeviceCredentialIdentity, DeviceRole, DirectGroup, DirectRecipientEndpoint,
    E2EE_CONTENT_TYPE, E2EE_PROTOCOL_VERSION,
};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Command { Join { welcome: String }, Ack, Decrypt { ciphertext: String }, EncryptReply }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response { success: bool, #[serde(skip_serializing_if = "Option::is_none")] key_package: Option<String>, #[serde(skip_serializing_if = "Option::is_none")] ciphertext: Option<String>, #[serde(skip_serializing_if = "Option::is_none")] text: Option<String>, #[serde(skip_serializing_if = "Option::is_none")] error: Option<String> }

fn aad(epoch: u64, sender: &[u8], message: &[u8]) -> CanonicalAad {
    CanonicalAad { protocol_version: E2EE_PROTOCOL_VERSION, content_type: E2EE_CONTENT_TYPE,
        group_id: b"cross-process-group".to_vec(), epoch,
        target_agent_did: b"did:voko:cross-process-agent".to_vec(),
        conversation_scope: b"cross-process-conversation".to_vec(),
        sender_device_key_id: sender.to_vec(), message_id: message.to_vec(), channel_type: 1 }
}

fn main() {
    let identity = DeviceCredentialIdentity { role: DeviceRole::OwnerDevice,
        principal_id: b"cross-process-principal".to_vec(), device_key_id: b"cross-process-owner".to_vec(),
        key_epoch: 1, target_agent_did: b"did:voko:cross-process-agent".to_vec() };
    let mut recipient = Some(DirectRecipientEndpoint::new(&identity).expect("recipient endpoint"));
    let key_package = STANDARD_NO_PAD.encode(recipient.as_ref().unwrap().serialized_key_package());
    let mut group: Option<DirectGroup> = None;
    let mut out = io::stdout().lock();
    write_response(&mut out, Response { success: true, key_package: Some(key_package), ciphertext: None, text: None, error: None });
    for line in io::stdin().lock().lines() {
        let response = match line.map_err(|e| e.to_string()).and_then(|line| serde_json::from_str::<Command>(&line).map_err(|e| e.to_string())) {
            Ok(Command::Join { welcome }) => STANDARD_NO_PAD.decode(welcome).map_err(|e| e.to_string())
                .and_then(|bytes| recipient.take().ok_or("recipient already joined".into()).and_then(|r| r.join(&bytes).map_err(|e| e.to_string())))
                .map(|joined| { group = Some(joined); ok() }).unwrap_or_else(fail),
            Ok(Command::Ack) => group.as_mut().ok_or("group not joined".to_string()).and_then(|g| {
                let route = aad(g.epoch(), b"cross-process-owner", b"group-established-ack");
                g.encrypt(&route, b"GROUP_ESTABLISHED").map(|c| STANDARD_NO_PAD.encode(c)).map_err(|e| e.to_string())
            }).and_then(|ciphertext| {
                let snapshot = group.as_ref().ok_or("group not joined".to_string())?.snapshot().map_err(|e| e.to_string())?;
                group = Some(DirectGroup::restore(&snapshot).map_err(|e| e.to_string())?);
                Ok(Response { success: true, key_package: None, ciphertext: Some(ciphertext), text: None, error: None })
            }).unwrap_or_else(fail),
            Ok(Command::Decrypt { ciphertext }) => group.as_mut().ok_or("group not joined".to_string()).and_then(|g| {
                let route = aad(g.epoch(), b"cross-process-browser", b"application-1");
                STANDARD_NO_PAD.decode(ciphertext).map_err(|e| e.to_string()).and_then(|c| g.decrypt(&route, &c).map_err(|e| e.to_string()))
            }).and_then(|p| String::from_utf8(p).map_err(|e| e.to_string())).and_then(|text| {
                let snapshot = group.as_ref().ok_or("group not joined".to_string())?.snapshot().map_err(|e| e.to_string())?;
                group = Some(DirectGroup::restore(&snapshot).map_err(|e| e.to_string())?);
                Ok(Response { success: true, key_package: None, ciphertext: None, text: Some(text), error: None })
            }).unwrap_or_else(fail),
            Ok(Command::EncryptReply) => group.as_mut().ok_or("group not joined".to_string()).and_then(|g| {
                let route = aad(g.epoch(), b"cross-process-owner", b"application-reply-1");
                g.encrypt(&route, b"reply from Lite process").map(|c| STANDARD_NO_PAD.encode(c)).map_err(|e| e.to_string())
            }).map(|ciphertext| Response { success: true, key_package: None, ciphertext: Some(ciphertext), text: None, error: None }).unwrap_or_else(fail),
            Err(error) => fail(error),
        };
        write_response(&mut out, response);
    }
}

fn ok() -> Response { Response { success: true, key_package: None, ciphertext: None, text: None, error: None } }
fn fail(error: String) -> Response { Response { success: false, key_package: None, ciphertext: None, text: None, error: Some(error) } }
fn write_response(out: &mut impl Write, response: Response) { serde_json::to_writer(&mut *out, &response).unwrap(); writeln!(out).unwrap(); out.flush().unwrap(); }
