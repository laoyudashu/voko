#![cfg(not(target_arch = "wasm32"))]

use voko_e2ee_core::{
    AtomicStateStore, CanonicalAad, DirectGroupPair, KeyPackageBinding, KeyPackageLedger,
    PinStatus, RecordVault, WireEnvelope, E2EE_CONTENT_TYPE, E2EE_PROTOCOL_VERSION,
};

const VAULT_KEY: &[u8; 32] = b"fake-im-test-master-key-32-bytes";

#[derive(Default)]
struct FakeWuKongIm {
    connected: bool,
    authenticated: bool,
    stored_envelopes: Vec<String>,
}

impl FakeWuKongIm {
    fn send(&mut self, envelope: &WireEnvelope, lose_ack: bool) -> Result<bool, &'static str> {
        if !self.connected {
            return Err("1006");
        }
        if !self.authenticated {
            return Err("authentication_failed");
        }
        self.stored_envelopes
            .push(serde_json::to_string(envelope).unwrap());
        Ok(!lose_ack)
    }

    fn drain(&mut self, reverse: bool) -> Vec<WireEnvelope> {
        let mut messages: Vec<_> = self
            .stored_envelopes
            .drain(..)
            .map(|raw| serde_json::from_str(&raw).unwrap())
            .collect();
        if reverse {
            messages.reverse();
        }
        messages
    }
}

fn aad(message_id: &str) -> CanonicalAad {
    CanonicalAad {
        protocol_version: E2EE_PROTOCOL_VERSION,
        content_type: E2EE_CONTENT_TYPE,
        group_id: b"fake-im-group".to_vec(),
        epoch: 1,
        target_agent_did: b"did:voko:fake-im-agent".to_vec(),
        conversation_scope: b"fake-im-conversation".to_vec(),
        sender_device_key_id: b"fake-im-browser-key".to_vec(),
        message_id: message_id.as_bytes().to_vec(),
        channel_type: 1,
    }
}

#[test]
fn fake_im_faults_never_leak_downgrade_duplicate_or_reorder_plaintext() {
    let mut pair = DirectGroupPair::establish(
        b"fake-im-group",
        b"fake-im-browser",
        b"fake-im-owner",
        &mut KeyPackageLedger::default(),
    )
    .unwrap();
    let mut sender_store = AtomicStateStore::in_memory().unwrap();
    let mut receiver_store = AtomicStateStore::in_memory().unwrap();
    let mut sender_version = 0;
    let mut receiver_version = 0;
    let mut im = FakeWuKongIm::default();
    let vault = RecordVault::from_master_key(VAULT_KEY).unwrap();
    let mut provider_deliveries = Vec::new();
    let mut plaintext_fallbacks = 0;
    let key_package_binding = KeyPackageBinding {
        target_agent_did: "did:voko:fake-im-agent".into(),
        owner_device_key_id: "fake-im-owner-key".into(),
        key_epoch: 1,
    };
    receiver_store
        .register_key_package(
            &pair.serialized_recipient_key_package,
            &key_package_binding,
            1_000,
            2_000,
        )
        .unwrap();
    receiver_store
        .consume_key_package(
            &pair.serialized_recipient_key_package,
            "fake-im-group",
            &key_package_binding,
            1_100,
        )
        .unwrap();
    assert_eq!(
        receiver_store
            .pin_or_verify_credential(
                "fake-im-browser-principal",
                1,
                "fake-im-browser-key",
                1,
                &pair.creator.signer_public_key(),
            )
            .unwrap(),
        PinStatus::PinnedNew
    );
    assert_eq!(
        receiver_store
            .pin_or_verify_credential(
                "fake-im-owner-device",
                2,
                "fake-im-owner-key",
                1,
                &pair.recipient.signer_public_key(),
            )
            .unwrap(),
        PinStatus::PinnedNew
    );

    let prepare = |message_id: &str,
                   plaintext: &str,
                   pair: &mut DirectGroupPair,
                   store: &mut AtomicStateStore,
                   version: &mut u64| {
        let route = aad(message_id);
        let ciphertext = pair.creator.encrypt(&route, plaintext.as_bytes()).unwrap();
        let sealed_state = vault
            .seal(
                format!("sender-state/{message_id}").as_bytes(),
                &pair.creator.snapshot().unwrap(),
            )
            .unwrap();
        store
            .commit_prepared(
                "fake-im-group",
                *version,
                &sealed_state,
                message_id,
                &ciphertext,
            )
            .unwrap();
        *version += 1;
        WireEnvelope::new(&route, &ciphertext).unwrap()
    };

    let disconnected = prepare(
        "message-disconnected",
        "CANARY_DISCONNECTED",
        &mut pair,
        &mut sender_store,
        &mut sender_version,
    );
    assert_eq!(im.send(&disconnected, false), Err("1006"));
    assert!(im.stored_envelopes.is_empty());

    im.connected = true;
    let unauthorized = prepare(
        "message-auth",
        "CANARY_AUTH",
        &mut pair,
        &mut sender_store,
        &mut sender_version,
    );
    assert_eq!(im.send(&unauthorized, false), Err("authentication_failed"));
    assert!(im.stored_envelopes.is_empty());

    im.authenticated = true;
    assert!(im.send(&disconnected, false).unwrap());
    let ack_lost = prepare(
        "message-ack-lost",
        "CANARY_ACK_LOST",
        &mut pair,
        &mut sender_store,
        &mut sender_version,
    );
    assert!(!im.send(&ack_lost, true).unwrap());
    assert!(im.send(&ack_lost, false).unwrap());

    let process = |envelope: WireEnvelope,
                   pair: &mut DirectGroupPair,
                   store: &mut AtomicStateStore,
                   version: &mut u64,
                   fallbacks: &mut usize| {
        if store.has_received(&envelope.message_id).unwrap() {
            return;
        }
        let result = envelope.aad().and_then(|route| {
            envelope
                .ciphertext_bytes()
                .map(|ciphertext| (route, ciphertext))
        });
        let Ok((route, ciphertext)) = result else {
            return;
        };
        let Ok(plaintext) = pair.recipient.decrypt(&route, &ciphertext) else {
            // Invalid E2EE data is discarded and never enters the visitor path.
            assert_eq!(*fallbacks, 0);
            return;
        };
        let sealed_state = vault
            .seal(
                format!("receiver-state/{}", envelope.message_id).as_bytes(),
                &pair.recipient.snapshot().unwrap(),
            )
            .unwrap();
        let sealed_payload = vault
            .seal(
                format!("payload/{}", envelope.message_id).as_bytes(),
                &plaintext,
            )
            .unwrap();
        if store
            .commit_received(
                "fake-im-group",
                *version,
                &sealed_state,
                &envelope.message_id,
                &sealed_payload,
            )
            .unwrap()
        {
            *version += 1;
        }
    };

    for envelope in im.drain(false) {
        process(
            envelope,
            &mut pair,
            &mut receiver_store,
            &mut receiver_version,
            &mut plaintext_fallbacks,
        );
    }
    assert_eq!(receiver_store.pending_received_count().unwrap(), 2);

    let order_one = prepare(
        "message-order-1",
        "CANARY_ORDER_ONE",
        &mut pair,
        &mut sender_store,
        &mut sender_version,
    );
    let order_two = prepare(
        "message-order-2",
        "CANARY_ORDER_TWO",
        &mut pair,
        &mut sender_store,
        &mut sender_version,
    );
    im.send(&order_one, false).unwrap();
    im.send(&order_two, false).unwrap();
    assert!(im
        .stored_envelopes
        .iter()
        .all(|raw| !raw.contains("CANARY_")));
    for envelope in im.drain(true) {
        process(
            envelope,
            &mut pair,
            &mut receiver_store,
            &mut receiver_version,
            &mut plaintext_fallbacks,
        );
    }

    let mut tampered = prepare(
        "message-tampered",
        "CANARY_TAMPERED",
        &mut pair,
        &mut sender_store,
        &mut sender_version,
    );
    tampered.target_agent_did = "did:voko:wrong-agent".into();
    process(
        tampered,
        &mut pair,
        &mut receiver_store,
        &mut receiver_version,
        &mut plaintext_fallbacks,
    );

    while let Some(claimed) = receiver_store
        .claim_next_received("provider-worker", 100, 1_000)
        .unwrap()
    {
        let message_id = claimed.message_id;
        let plaintext = vault
            .open(
                format!("payload/{message_id}").as_bytes(),
                &claimed.encrypted_payload,
            )
            .unwrap();
        provider_deliveries.push((
            message_id.clone(),
            String::from_utf8(plaintext.to_vec()).unwrap(),
        ));
        receiver_store
            .mark_received_dispatched(&message_id, "provider-worker")
            .unwrap();
    }
    assert_eq!(plaintext_fallbacks, 0);
    assert_eq!(provider_deliveries.len(), 4);
    assert_eq!(
        provider_deliveries
            .iter()
            .filter(|(id, _)| id == "message-ack-lost")
            .count(),
        1
    );
    assert_eq!(provider_deliveries[2].0, "message-order-2");
    assert_eq!(provider_deliveries[3].0, "message-order-1");
    assert!(provider_deliveries
        .iter()
        .all(|(id, _)| id != "message-tampered"));
}
