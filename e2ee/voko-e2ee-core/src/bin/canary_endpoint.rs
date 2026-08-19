use std::io::{self, BufRead, Write};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use voko_e2ee_core::{
    CanonicalAad, DeviceCredentialIdentity, DeviceRole, DirectCreatorEndpoint, DirectGroup,
    DirectRecipientEndpoint, SystemWrappingKeyStore, VaultKeyManager, WireEnvelope,
    E2EE_CONTENT_TYPE, E2EE_PROTOCOL_VERSION,
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    Creator,
    Recipient,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    BindRoute { group_id: String, conversation: String },
    PrepareAdd { key_package: String },
    AcceptAdd,
    Join { welcome: String },
    Encrypt { message_id: String, text: String },
    Decrypt { envelope: WireEnvelope },
    Snapshot,
    Restore { snapshot: String },
    SealSnapshot,
    RestoreSealed { sealed_snapshot: String },
    SealPending,
    RestorePending { sealed_snapshot: String },
    RevokeVault,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    key_package: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    credential_public_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    welcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    envelope: Option<WireEnvelope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    snapshot: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sealed_snapshot: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn required(name: &str) -> Result<String, String> {
    std::env::args()
        .find_map(|arg| arg.strip_prefix(&format!("--{name}=")).map(str::to_owned))
        .filter(|value| {
            !value.is_empty() && value.len() <= 2048 && !value.chars().any(char::is_control)
        })
        .ok_or_else(|| format!("missing or invalid --{name}"))
}

fn empty() -> Response {
    Response {
        success: true,
        role: None,
        key_package: None,
        credential_public_key: None,
        commit: None,
        welcome: None,
        envelope: None,
        text: None,
        snapshot: None,
        sealed_snapshot: None,
        error: None,
    }
}

fn failure(error: impl ToString) -> Response {
    Response {
        success: false,
        error: Some(error.to_string()),
        ..empty()
    }
}

fn main() {
    let result = run();
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), String> {
    let role = match required("role")?.as_str() {
        "creator" => Role::Creator,
        "recipient" => Role::Recipient,
        _ => return Err("--role must be creator or recipient".into()),
    };
    let principal = required("principal")?;
    let device = required("device")?;
    let agent = required("agent")?;
    let mut group_id = required("group")?;
    let mut conversation = required("conversation")?;
    let owner_scope = required("owner-scope")?;
    let identity = DeviceCredentialIdentity {
        role: if role == Role::Creator {
            DeviceRole::Browser
        } else {
            DeviceRole::OwnerDevice
        },
        principal_id: principal.as_bytes().to_vec(),
        device_key_id: device.as_bytes().to_vec(),
        key_epoch: 1,
        target_agent_did: agent.as_bytes().to_vec(),
    };
    let mut creator = if role == Role::Creator {
        Some(
            DirectCreatorEndpoint::new(group_id.as_bytes(), &identity)
                .map_err(|e| e.to_string())?,
        )
    } else {
        None
    };
    let mut recipient = if role == Role::Recipient {
        Some(DirectRecipientEndpoint::new(&identity).map_err(|e| e.to_string())?)
    } else {
        None
    };
    let mut group: Option<DirectGroup> = None;
    let credential_public_key = match role {
        Role::Creator => creator.as_ref().unwrap().signer_public_key(),
        Role::Recipient => recipient.as_ref().unwrap().signer_public_key(),
    };
    let mut ready = empty();
    ready.role = Some(if role == Role::Creator {
        "creator"
    } else {
        "recipient"
    });
    ready.credential_public_key = Some(URL_SAFE_NO_PAD.encode(credential_public_key));
    ready.key_package = recipient
        .as_ref()
        .map(|endpoint| URL_SAFE_NO_PAD.encode(endpoint.serialized_key_package()));
    write_response(&ready);

    for line in io::stdin().lock().lines() {
        let response = line
            .map_err(|e| e.to_string())
            .and_then(|line| serde_json::from_str::<Command>(&line).map_err(|e| e.to_string()))
            .and_then(|command| {
                handle(
                    command,
                    role,
                    &device,
                    &agent,
                    &mut group_id,
                    &mut conversation,
                    &owner_scope,
                    &mut creator,
                    &mut recipient,
                    &mut group,
                )
            })
            .unwrap_or_else(failure);
        write_response(&response);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn handle(
    command: Command,
    role: Role,
    device: &str,
    agent: &str,
    group_id: &mut String,
    conversation: &mut String,
    owner_scope: &str,
    creator: &mut Option<DirectCreatorEndpoint>,
    recipient: &mut Option<DirectRecipientEndpoint>,
    group: &mut Option<DirectGroup>,
) -> Result<Response, String> {
    match command {
        Command::BindRoute { group_id: next_group_id, conversation: next_conversation }
            if role == Role::Recipient && group.is_none() => {
            if next_group_id.is_empty() || next_group_id.len() > 2048 || next_group_id.chars().any(char::is_control)
                || next_conversation.is_empty() || next_conversation.len() > 2048 || next_conversation.chars().any(char::is_control) {
                return Err("invalid route binding".into());
            }
            *group_id = next_group_id;
            *conversation = next_conversation;
            Ok(empty())
        }
        Command::PrepareAdd { key_package } if role == Role::Creator => {
            let bytes = URL_SAFE_NO_PAD
                .decode(key_package)
                .map_err(|_| "invalid KeyPackage")?;
            let prepared = creator
                .as_mut()
                .ok_or("creator is not pending")?
                .prepare_add(&bytes)
                .map_err(|e| e.to_string())?;
            Ok(Response {
                commit: Some(URL_SAFE_NO_PAD.encode(prepared.commit)),
                welcome: Some(URL_SAFE_NO_PAD.encode(prepared.welcome)),
                ..empty()
            })
        }
        Command::AcceptAdd if role == Role::Creator => {
            *group = Some(
                creator
                    .take()
                    .ok_or("creator is not pending")?
                    .accept_add()
                    .map_err(|e| e.to_string())?,
            );
            Ok(empty())
        }
        Command::Join { welcome } if role == Role::Recipient => {
            let bytes = URL_SAFE_NO_PAD
                .decode(welcome)
                .map_err(|_| "invalid Welcome")?;
            *group = Some(
                recipient
                    .take()
                    .ok_or("recipient already joined")?
                    .join(&bytes)
                    .map_err(|e| e.to_string())?,
            );
            Ok(empty())
        }
        Command::Encrypt { message_id, text } => {
            let active = group.as_mut().ok_or("group is not active")?;
            let route = CanonicalAad {
                protocol_version: E2EE_PROTOCOL_VERSION,
                content_type: E2EE_CONTENT_TYPE,
                group_id: group_id.as_bytes().to_vec(),
                epoch: active.epoch(),
                target_agent_did: agent.as_bytes().to_vec(),
                conversation_scope: conversation.as_bytes().to_vec(),
                sender_device_key_id: device.as_bytes().to_vec(),
                message_id: message_id.into_bytes(),
                channel_type: 1,
            };
            let ciphertext = active
                .encrypt(&route, text.as_bytes())
                .map_err(|e| e.to_string())?;
            let envelope = WireEnvelope::new(&route, &ciphertext).map_err(|e| e.to_string())?;
            Ok(Response {
                envelope: Some(envelope),
                ..empty()
            })
        }
        Command::Decrypt { envelope } => {
            let route = envelope.aad().map_err(|e| e.to_string())?;
            if route.target_agent_did != agent.as_bytes()
                || route.group_id != group_id.as_bytes()
                || route.conversation_scope != conversation.as_bytes()
            {
                return Err("authenticated route scope mismatch".into());
            }
            let ciphertext = envelope.ciphertext_bytes().map_err(|e| e.to_string())?;
            let plaintext = group
                .as_mut()
                .ok_or("group is not active")?
                .decrypt(&route, &ciphertext)
                .map_err(|e| e.to_string())?;
            Ok(Response {
                text: Some(String::from_utf8(plaintext).map_err(|_| "plaintext is not UTF-8")?),
                ..empty()
            })
        }
        Command::Snapshot => {
            let snapshot = group
                .as_ref()
                .ok_or("group is not active")?
                .snapshot()
                .map_err(|e| e.to_string())?;
            Ok(Response {
                snapshot: Some(URL_SAFE_NO_PAD.encode(snapshot)),
                ..empty()
            })
        }
        Command::Restore { snapshot } => {
            let bytes = URL_SAFE_NO_PAD
                .decode(snapshot)
                .map_err(|_| "invalid snapshot")?;
            *group = Some(DirectGroup::restore(&bytes).map_err(|e| e.to_string())?);
            *creator = None;
            *recipient = None;
            Ok(empty())
        }
        Command::SealSnapshot => {
            let snapshot = group
                .as_ref()
                .ok_or("group is not active")?
                .snapshot()
                .map_err(|e| e.to_string())?;
            let vault = unlock_or_provision(owner_scope)?;
            let sealed = vault
                .seal(&vault_context(agent, group_id, conversation), &snapshot)
                .map_err(|e| e.to_string())?;
            Ok(Response {
                sealed_snapshot: Some(URL_SAFE_NO_PAD.encode(sealed)),
                ..empty()
            })
        }
        Command::RestoreSealed { sealed_snapshot } => {
            let sealed = URL_SAFE_NO_PAD
                .decode(sealed_snapshot)
                .map_err(|_| "invalid sealed snapshot")?;
            let vault = VaultKeyManager::new(SystemWrappingKeyStore)
                .unlock(owner_scope.as_bytes())
                .map_err(|e| e.to_string())?;
            let snapshot = vault
                .open(&vault_context(agent, group_id, conversation), &sealed)
                .map_err(|e| e.to_string())?;
            *group = Some(DirectGroup::restore(snapshot.as_ref()).map_err(|e| e.to_string())?);
            *creator = None;
            *recipient = None;
            Ok(empty())
        }
        Command::SealPending if role == Role::Recipient && group.is_none() => {
            let snapshot = recipient.as_ref().ok_or("recipient is not pending")?.snapshot().map_err(|e| e.to_string())?;
            let vault = unlock_or_provision(owner_scope)?;
            let sealed = vault.seal(&vault_context(agent, group_id, conversation), &snapshot).map_err(|e| e.to_string())?;
            Ok(Response { sealed_snapshot: Some(URL_SAFE_NO_PAD.encode(sealed)), ..empty() })
        }
        Command::RestorePending { sealed_snapshot } if role == Role::Recipient && group.is_none() => {
            let sealed = URL_SAFE_NO_PAD.decode(sealed_snapshot).map_err(|_| "invalid sealed pending snapshot")?;
            let vault = VaultKeyManager::new(SystemWrappingKeyStore).unlock(owner_scope.as_bytes()).map_err(|e| e.to_string())?;
            let snapshot = vault.open(&vault_context(agent, group_id, conversation), &sealed).map_err(|e| e.to_string())?;
            *recipient = Some(DirectRecipientEndpoint::restore(snapshot.as_ref()).map_err(|e| e.to_string())?);
            Ok(empty())
        }
        Command::RevokeVault => {
            VaultKeyManager::new(SystemWrappingKeyStore)
                .revoke(owner_scope.as_bytes())
                .map_err(|e| e.to_string())?;
            *group = None;
            *creator = None;
            *recipient = None;
            Ok(empty())
        }
        _ => Err("operation is not valid for this endpoint role".into()),
    }
}

fn unlock_or_provision(owner_scope: &str) -> Result<voko_e2ee_core::RecordVault, String> {
    let manager = VaultKeyManager::new(SystemWrappingKeyStore);
    match manager.unlock(owner_scope.as_bytes()) {
        Ok(vault) => Ok(vault),
        Err(voko_e2ee_core::VaultKeyError::NotProvisioned) => manager
            .provision(owner_scope.as_bytes())
            .map_err(|e| e.to_string()),
        Err(error) => Err(error.to_string()),
    }
}

fn vault_context(agent: &str, group_id: &str, conversation: &str) -> Vec<u8> {
    let mut context = b"voko-e2ee-canary-state/1".to_vec();
    for value in [agent, group_id, conversation] {
        context.extend_from_slice(&(value.len() as u32).to_be_bytes());
        context.extend_from_slice(value.as_bytes());
    }
    context
}

fn write_response(response: &Response) {
    let mut out = io::stdout().lock();
    serde_json::to_writer(&mut out, response).unwrap();
    writeln!(out).unwrap();
    out.flush().unwrap();
}
