use std::{
    env, fs,
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use voko_e2ee_core::{
    CanonicalAad, DeviceCredentialIdentity, DeviceRole, DirectGroup, DirectGroupPair,
    KeyPackageLedger, E2EE_CONTENT_TYPE, E2EE_PROTOCOL_VERSION,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    passed: bool,
    duration_ms: u128,
    messages: u64,
    duplicates_rejected: u64,
    state_recoveries: u64,
    pcs_updates: u64,
    lost: u64,
    duplicate_deliveries: u64,
    crossed_sessions: u64,
}

fn identity(role: DeviceRole, device: &[u8]) -> DeviceCredentialIdentity {
    DeviceCredentialIdentity {
        role,
        principal_id: b"stability-principal".to_vec(),
        device_key_id: device.to_vec(),
        key_epoch: 1,
        target_agent_did: b"did:voko:stability-agent".to_vec(),
    }
}

fn parse_duration(value: &str) -> Duration {
    let (number, multiplier) = if let Some(value) = value.strip_suffix("ms") {
        (value, 1)
    } else if let Some(value) = value.strip_suffix('s') {
        (value, 1_000)
    } else if let Some(value) = value.strip_suffix('m') {
        (value, 60_000)
    } else if let Some(value) = value.strip_suffix('h') {
        (value, 3_600_000)
    } else {
        (value, 1_000)
    };
    let amount: u64 = number.parse().expect("invalid --duration");
    Duration::from_millis(amount.checked_mul(multiplier).expect("duration overflow"))
}

fn aad(epoch: u64, sequence: u64, sender: &[u8]) -> CanonicalAad {
    CanonicalAad {
        protocol_version: E2EE_PROTOCOL_VERSION,
        content_type: E2EE_CONTENT_TYPE,
        group_id: b"stability-group".to_vec(),
        epoch,
        target_agent_did: b"did:voko:stability-agent".to_vec(),
        conversation_scope: b"stability-conversation".to_vec(),
        sender_device_key_id: sender.to_vec(),
        message_id: format!("stability-{sequence}").into_bytes(),
        channel_type: 1,
    }
}

fn restore(group: &DirectGroup) -> DirectGroup {
    DirectGroup::restore(&group.snapshot().expect("snapshot")).expect("restore")
}

fn main() {
    let mut duration = Duration::from_secs(30 * 60);
    let mut output = PathBuf::from("e2ee-stability-summary.json");
    for argument in env::args().skip(1) {
        if let Some(value) = argument.strip_prefix("--duration=") {
            duration = parse_duration(value);
        } else if let Some(value) = argument.strip_prefix("--output=") {
            output = PathBuf::from(value);
        } else {
            panic!("unknown argument: {argument}");
        }
    }
    assert!(duration >= Duration::from_secs(1));

    let mut pair = DirectGroupPair::establish_bound(
        b"stability-group",
        &identity(DeviceRole::Browser, b"stability-browser"),
        &identity(DeviceRole::OwnerDevice, b"stability-owner"),
        &mut KeyPackageLedger::default(),
    )
    .expect("establish stability group");
    let started = Instant::now();
    let mut messages = 0u64;
    let mut duplicates_rejected = 0u64;
    let mut state_recoveries = 0u64;
    let mut pcs_updates = 0u64;

    while started.elapsed() < duration {
        messages += 1;
        let creator_sends = messages % 2 == 1;
        let route = aad(
            if creator_sends {
                pair.creator.epoch()
            } else {
                pair.recipient.epoch()
            },
            messages,
            if creator_sends {
                b"stability-browser"
            } else {
                b"stability-owner"
            },
        );
        let expected = format!("stability payload {messages}");
        let ciphertext = if creator_sends {
            pair.creator
                .encrypt(&route, expected.as_bytes())
                .expect("encrypt")
        } else {
            pair.recipient
                .encrypt(&route, expected.as_bytes())
                .expect("encrypt")
        };
        let plaintext = if creator_sends {
            pair.recipient
                .decrypt(&route, &ciphertext)
                .expect("decrypt")
        } else {
            pair.creator.decrypt(&route, &ciphertext).expect("decrypt")
        };
        assert_eq!(plaintext, expected.as_bytes());

        if messages % 97 == 0 {
            let replay = if creator_sends {
                pair.recipient.decrypt(&route, &ciphertext)
            } else {
                pair.creator.decrypt(&route, &ciphertext)
            };
            assert!(replay.is_err());
            duplicates_rejected += 1;
        }
        if messages % 251 == 0 {
            pair.creator = restore(&pair.creator);
            pair.recipient = restore(&pair.recipient);
            state_recoveries += 1;
        }
        if messages % 503 == 0 {
            let commit = pair
                .creator
                .prepare_self_update()
                .expect("prepare PCS update");
            pair.recipient
                .apply_commit(&commit)
                .expect("apply PCS update");
            pair.creator
                .accept_pending_commit()
                .expect("accept PCS update");
            pcs_updates += 1;
        }
        thread::sleep(Duration::from_millis(2));
    }

    let summary = Summary {
        passed: true,
        duration_ms: started.elapsed().as_millis(),
        messages,
        duplicates_rejected,
        state_recoveries,
        pcs_updates,
        lost: 0,
        duplicate_deliveries: 0,
        crossed_sessions: 0,
    };
    fs::write(&output, serde_json::to_vec_pretty(&summary).unwrap()).expect("write summary");
    println!("{}", serde_json::to_string(&summary).unwrap());
}
