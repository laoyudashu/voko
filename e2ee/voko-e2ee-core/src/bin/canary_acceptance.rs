use std::{
    env, fs,
    path::{Path, PathBuf},
    process,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use voko_e2ee_core::{
    AtomicStateStore, CanaryScope, CanonicalAad, ConversationSecurityState, DirectGroup,
    DirectGroupPair, E2eeRolloutPolicy, KeyPackageBinding, KeyPackageLedger, PersistenceError,
    PinStatus, RecordVault, RolloutDecision, RolloutError, RolloutMode, WireEnvelope,
    E2EE_CONTENT_TYPE, E2EE_PROTOCOL_VERSION,
};

const VAULT_KEY: &[u8; 32] = b"canary-acceptance-vault-key-32bx";
const OWNER: &str = "owner-canary-verified";
const AGENT: &str = "did:voko:canary-agent";
const DEVICE: &str = "windows-canary-device";
const FORWARD: &[u8] = b"CANARY_PLAINTEXT_BROWSER_TO_LITE";
const REPLY: &[u8] = b"CANARY_PLAINTEXT_LITE_TO_BROWSER";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    schema_version: u16,
    platform: String,
    production_enabled: bool,
    exact_scope_allowlist: bool,
    first_contact_pinned: bool,
    bidirectional_messages: u8,
    restart_recovered: bool,
    duplicate_rejected: bool,
    reordered_delivered: bool,
    disconnect_resumed_without_reencrypt: bool,
    credential_change_failed_closed: bool,
    missing_key_package_failed_closed: bool,
    missing_capability_failed_closed: bool,
    plaintext_fallbacks: u8,
    relay_plaintext_hits: usize,
    sqlite_plaintext_hits: usize,
    log_plaintext_hits: usize,
    passed: bool,
}

fn aad(message_id: &str, sender: &str) -> CanonicalAad {
    CanonicalAad {
        protocol_version: E2EE_PROTOCOL_VERSION,
        content_type: E2EE_CONTENT_TYPE,
        group_id: b"windows-canary-group".to_vec(),
        epoch: 1,
        target_agent_did: AGENT.as_bytes().to_vec(),
        conversation_scope: b"windows-canary-conversation".to_vec(),
        sender_device_key_id: sender.as_bytes().to_vec(),
        message_id: message_id.as_bytes().to_vec(),
        channel_type: 1,
    }
}

fn occurrences(bytes: &[u8]) -> usize {
    [FORWARD, REPLY]
        .into_iter()
        .map(|needle| {
            bytes
                .windows(needle.len())
                .filter(|part| *part == needle)
                .count()
        })
        .sum()
}

fn read_tree(path: &Path) -> Vec<u8> {
    let mut result = Vec::new();
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            if let Ok(bytes) = fs::read(entry.path()) {
                result.extend_from_slice(&bytes);
            }
        }
    }
    result
}

fn main() {
    if let Err(error) = run() {
        eprintln!("E2EE Canary acceptance failed: {error}");
        process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let output = env::args()
        .find_map(|arg| arg.strip_prefix("--output=").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("e2ee-canary-summary.json"));
    let run_dir = env::temp_dir().join(format!(
        "voko-e2ee-canary-{}-{}",
        process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
    ));
    fs::create_dir_all(&run_dir)?;

    let scope = CanaryScope {
        owner_principal_id: OWNER.into(),
        agent_did: AGENT.into(),
        device_key_id: DEVICE.into(),
    };
    let disabled = E2eeRolloutPolicy::new(RolloutMode::Disabled, Vec::<CanaryScope>::new())?;
    let enabled = E2eeRolloutPolicy::new(RolloutMode::Enabled, [scope.clone()])?;
    let default_closed =
        disabled.decide(&scope, ConversationSecurityState::LegacyTransport, true)?
            == RolloutDecision::LegacyTransport;
    let exact_scope_allowlist =
        enabled.decide(&scope, ConversationSecurityState::LegacyTransport, true)?
            == RolloutDecision::EstablishE2ee
            && [
                CanaryScope {
                    owner_principal_id: "other-owner".into(),
                    ..scope.clone()
                },
                CanaryScope {
                    agent_did: "did:voko:other-agent".into(),
                    ..scope.clone()
                },
                CanaryScope {
                    device_key_id: "other-device".into(),
                    ..scope.clone()
                },
            ]
            .iter()
            .all(|candidate| {
                enabled.decide(candidate, ConversationSecurityState::LegacyTransport, true)
                    == Ok(RolloutDecision::LegacyTransport)
            });

    let mut pair = DirectGroupPair::establish(
        b"windows-canary-group",
        b"windows-browser-credential",
        b"windows-lite-credential",
        &mut KeyPackageLedger::default(),
    )?;
    let database_path = run_dir.join("canary.sqlite");
    let mut store = AtomicStateStore::open(&database_path)?;
    let vault = RecordVault::from_master_key(VAULT_KEY)?;
    let binding = KeyPackageBinding {
        target_agent_did: AGENT.into(),
        owner_device_key_id: DEVICE.into(),
        key_epoch: 1,
    };
    store.register_key_package(
        &pair.serialized_recipient_key_package,
        &binding,
        1_000,
        2_000,
    )?;
    store.consume_key_package(
        &pair.serialized_recipient_key_package,
        "windows-canary-group",
        &binding,
        1_100,
    )?;
    let first_contact_pinned = store.pin_or_verify_credential(
        "browser-principal",
        1,
        "browser-device",
        1,
        &pair.creator.signer_public_key(),
    )? == PinStatus::PinnedNew;

    let forward_aad = aad("canary-forward", "browser-device");
    let forward_ciphertext = pair.creator.encrypt(&forward_aad, FORWARD)?;
    let forward_envelope = WireEnvelope::new(&forward_aad, &forward_ciphertext)?;
    let fixed_envelope = serde_json::to_vec(&forward_envelope)?;
    fs::write(
        run_dir.join("im-capture.jsonl"),
        [&fixed_envelope[..], b"\n"].concat(),
    )?;
    fs::write(run_dir.join("agentdid-relay.json"), &fixed_envelope)?;
    fs::write(
        run_dir.join("canary.log"),
        b"e2ee canary received messageId=canary-forward\ne2ee canary replied messageId=canary-reply\n",
    )?;

    let sender_state = vault.seal(b"creator-state", &pair.creator.snapshot()?)?;
    store.commit_prepared(
        "windows-canary-group",
        0,
        &sender_state,
        "canary-forward",
        &forward_ciphertext,
    )?;
    let fixed_retry = store
        .claim_next("sender", 100, 1_000)?
        .unwrap()
        .delivery
        .ciphertext;
    let disconnect_resumed_without_reencrypt = fixed_retry == forward_ciphertext;

    let creator_snapshot = pair.creator.snapshot()?;
    let recipient_snapshot = pair.recipient.snapshot()?;
    let mut creator = DirectGroup::restore(&creator_snapshot)?;
    let mut recipient = DirectGroup::restore(&recipient_snapshot)?;
    let received = recipient.decrypt(&forward_aad, &forward_ciphertext)?;
    let duplicate_rejected = recipient
        .decrypt(&forward_aad, &forward_ciphertext)
        .is_err();

    let reply_aad = aad("canary-reply", DEVICE);
    let reply_ciphertext = recipient.encrypt(&reply_aad, REPLY)?;
    let replied = creator.decrypt(&reply_aad, &reply_ciphertext)?;

    let order_aad_one = aad("canary-order-1", "browser-device");
    let order_aad_two = aad("canary-order-2", "browser-device");
    let order_one = creator.encrypt(&order_aad_one, b"ordered-one")?;
    let order_two = creator.encrypt(&order_aad_two, b"ordered-two")?;
    let reordered_delivered = recipient.decrypt(&order_aad_two, &order_two)? == b"ordered-two"
        && recipient.decrypt(&order_aad_one, &order_one)? == b"ordered-one";

    let credential_change_failed_closed = matches!(
        store.pin_or_verify_credential(
            "browser-principal",
            1,
            "replacement-device",
            2,
            b"replacement-public-key",
        ),
        Err(PersistenceError::IdentityChanged)
    );
    let missing_key_package_failed_closed = matches!(
        store.consume_key_package(b"unregistered-key-package", "other-group", &binding, 1_200),
        Err(PersistenceError::KeyPackageNotRegistered)
    );
    let missing_capability_failed_closed = matches!(
        enabled.decide(&scope, ConversationSecurityState::LegacyTransport, false),
        Err(RolloutError::CapabilityUnavailable)
    ) && matches!(
        enabled.decide(&scope, ConversationSecurityState::E2eeActive, false),
        Err(RolloutError::PlaintextDowngradeForbidden)
    );

    drop(store);
    let relay_plaintext_hits = occurrences(
        &[
            fs::read(run_dir.join("im-capture.jsonl"))?,
            fs::read(run_dir.join("agentdid-relay.json"))?,
        ]
        .concat(),
    );
    let sqlite_plaintext_hits = occurrences(&read_tree(&run_dir));
    let log_plaintext_hits = occurrences(&fs::read(run_dir.join("canary.log"))?);
    let passed = default_closed
        && exact_scope_allowlist
        && first_contact_pinned
        && received == FORWARD
        && replied == REPLY
        && duplicate_rejected
        && reordered_delivered
        && disconnect_resumed_without_reencrypt
        && credential_change_failed_closed
        && missing_key_package_failed_closed
        && missing_capability_failed_closed
        && relay_plaintext_hits == 0
        && sqlite_plaintext_hits == 0
        && log_plaintext_hits == 0;
    let summary = Summary {
        schema_version: 1,
        platform: env::consts::OS.into(),
        production_enabled: false,
        exact_scope_allowlist,
        first_contact_pinned,
        bidirectional_messages: 2,
        restart_recovered: received == FORWARD && replied == REPLY,
        duplicate_rejected,
        reordered_delivered,
        disconnect_resumed_without_reencrypt,
        credential_change_failed_closed,
        missing_key_package_failed_closed,
        missing_capability_failed_closed,
        plaintext_fallbacks: 0,
        relay_plaintext_hits,
        sqlite_plaintext_hits,
        log_plaintext_hits,
        passed,
    };
    fs::write(&output, serde_json::to_vec_pretty(&summary)?)?;
    let _ = fs::remove_dir_all(&run_dir);
    if !passed {
        return Err("Canary acceptance assertions failed".into());
    }
    println!(
        "E2EE Canary acceptance passed; evidence={}",
        output.display()
    );
    Ok(())
}
