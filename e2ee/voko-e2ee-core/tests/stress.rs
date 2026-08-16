use voko_e2ee_core::{
    CanonicalAad, DeviceCredentialIdentity, DeviceRole, DirectGroupPair, KeyPackageLedger,
    E2EE_CONTENT_TYPE, E2EE_PROTOCOL_VERSION,
};

fn identity(role: DeviceRole, key: &[u8]) -> DeviceCredentialIdentity {
    DeviceCredentialIdentity {
        role,
        principal_id: b"stress-principal".to_vec(),
        device_key_id: key.to_vec(),
        key_epoch: 1,
        target_agent_did: b"did:voko:stress-agent".to_vec(),
    }
}

fn run_messages(count: usize) {
    let creator = identity(DeviceRole::Browser, b"stress-browser-key");
    let recipient = identity(DeviceRole::OwnerDevice, b"stress-owner-key");
    let mut pair = DirectGroupPair::establish_bound(
        b"stress-group",
        &creator,
        &recipient,
        &mut KeyPackageLedger::default(),
    )
    .unwrap();

    for sequence in 0..count {
        let message_id = format!("stress-{sequence}").into_bytes();
        let aad = CanonicalAad {
            protocol_version: E2EE_PROTOCOL_VERSION,
            content_type: E2EE_CONTENT_TYPE,
            group_id: b"stress-group".to_vec(),
            epoch: 1,
            target_agent_did: b"did:voko:stress-agent".to_vec(),
            conversation_scope: b"stress-conversation".to_vec(),
            sender_device_key_id: b"stress-browser-key".to_vec(),
            message_id,
            channel_type: 1,
        };
        let plaintext = format!("stress message {sequence}").into_bytes();
        let ciphertext = pair.creator.encrypt(&aad, &plaintext).unwrap();
        assert_eq!(
            pair.recipient.decrypt(&aad, &ciphertext).unwrap(),
            plaintext
        );
    }
}

#[test]
fn sustained_1000_message_gate() {
    run_messages(1_000);
}

#[test]
#[ignore = "run through npm run test:e2ee:stress"]
fn sustained_100000_message_release_gate() {
    run_messages(100_000);
}
