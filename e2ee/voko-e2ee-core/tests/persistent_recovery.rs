#![cfg(not(target_arch = "wasm32"))]

use voko_e2ee_core::{
    AtomicStateStore, CanonicalAad, DirectGroup, DirectGroupPair, EncryptedVault, KeyPackageLedger,
    VaultKdfParams, E2EE_CONTENT_TYPE, E2EE_PROTOCOL_VERSION,
};

fn aad(message_id: &[u8]) -> CanonicalAad {
    CanonicalAad {
        protocol_version: E2EE_PROTOCOL_VERSION,
        content_type: E2EE_CONTENT_TYPE,
        group_id: b"persistent-group".to_vec(),
        epoch: 1,
        target_agent_did: b"did:voko:persistent-agent".to_vec(),
        conversation_scope: b"persistent-conversation".to_vec(),
        sender_device_key_id: b"persistent-browser-key".to_vec(),
        message_id: message_id.to_vec(),
        channel_type: 1,
    }
}

#[test]
fn encrypted_group_state_and_outbox_survive_process_restart_together() {
    let mut pair = DirectGroupPair::establish(
        b"persistent-group",
        b"persistent-browser",
        b"persistent-owner",
        &mut KeyPackageLedger::default(),
    )
    .unwrap();
    let first_route = aad(b"persistent-message-1");
    let first_ciphertext = pair
        .creator
        .encrypt(&first_route, b"first command")
        .unwrap();
    let encrypted_state = EncryptedVault::seal(
        &pair.creator.snapshot().unwrap(),
        b"test-only-high-entropy-vault-secret",
        VaultKdfParams::default(),
    )
    .unwrap();

    let path = std::env::temp_dir().join(format!(
        "voko-e2ee-recovery-{}-{}.db",
        std::process::id(),
        rand::random::<u64>()
    ));
    {
        let mut store = AtomicStateStore::open(&path).unwrap();
        store
            .commit_prepared(
                "persistent-group",
                0,
                &encrypted_state,
                "persistent-message-1",
                &first_ciphertext,
            )
            .unwrap();
        let claimed = store
            .claim_next("worker-before-crash", 100, 10)
            .unwrap()
            .unwrap();
        assert_eq!(claimed.delivery.ciphertext, first_ciphertext);
    }

    let mut restored = {
        let mut store = AtomicStateStore::open(&path).unwrap();
        let (version, sealed) = store
            .encrypted_group_state("persistent-group")
            .unwrap()
            .unwrap();
        assert_eq!(version, 1);
        let snapshot =
            EncryptedVault::open(&sealed, b"test-only-high-entropy-vault-secret").unwrap();
        let restored = DirectGroup::restore(&snapshot).unwrap();
        let retried = store
            .claim_next("worker-after-crash", 110, 10)
            .unwrap()
            .unwrap();
        assert_eq!(retried.delivery.ciphertext, first_ciphertext);
        store
            .mark_sent("persistent-message-1", "worker-after-crash")
            .unwrap();
        restored
    };

    assert_eq!(
        pair.recipient
            .decrypt(&first_route, &first_ciphertext)
            .unwrap(),
        b"first command"
    );
    let second_route = aad(b"persistent-message-2");
    let second_ciphertext = restored.encrypt(&second_route, b"after restart").unwrap();
    assert_eq!(
        pair.recipient
            .decrypt(&second_route, &second_ciphertext)
            .unwrap(),
        b"after restart"
    );
    let _ = std::fs::remove_file(path);
}
