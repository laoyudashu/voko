use voko_e2ee_core::{
    AtomicStateStore, CanonicalAad, DeviceCredentialIdentity, DeviceRole, DirectCreatorEndpoint,
    DirectRecipientEndpoint, KeyPackageBinding, E2EE_CONTENT_TYPE, E2EE_PROTOCOL_VERSION,
};

fn identity(role: DeviceRole, device: &[u8]) -> DeviceCredentialIdentity {
    DeviceCredentialIdentity {
        role,
        principal_id: b"guest-principal-1".to_vec(),
        device_key_id: device.to_vec(),
        key_epoch: 1,
        target_agent_did: b"did:voko:independent-agent".to_vec(),
    }
}

fn aad(group_id: &[u8], epoch: u64, sender: &[u8], message: &[u8]) -> CanonicalAad {
    CanonicalAad {
        protocol_version: E2EE_PROTOCOL_VERSION,
        content_type: E2EE_CONTENT_TYPE,
        group_id: group_id.to_vec(),
        epoch,
        target_agent_did: b"did:voko:independent-agent".to_vec(),
        conversation_scope: b"guest-conversation-1".to_vec(),
        sender_device_key_id: sender.to_vec(),
        message_id: message.to_vec(),
        channel_type: 1,
    }
}

#[test]
fn independent_endpoints_establish_ack_and_exchange_without_shared_private_state() {
    let group_id = b"independent-group-1";
    let recipient = DirectRecipientEndpoint::new(&identity(
        DeviceRole::OwnerDevice,
        b"owner-device-independent",
    ))
    .unwrap();
    let serialized_key_package = recipient.serialized_key_package().to_vec();

    // Models the directory's endpoint-side single-use enforcement before the
    // creator is allowed to build an Add Commit.
    let mut store = AtomicStateStore::in_memory().unwrap();
    let binding = KeyPackageBinding {
        target_agent_did: "did:voko:independent-agent".into(),
        owner_device_key_id: "owner-device-independent".into(),
        key_epoch: 1,
    };
    store
        .register_key_package(&serialized_key_package, &binding, 1_000, 2_000)
        .unwrap();
    store
        .consume_key_package(
            &serialized_key_package,
            "independent-group-1",
            &binding,
            1_100,
        )
        .unwrap();

    let mut creator = DirectCreatorEndpoint::new(
        group_id,
        &identity(DeviceRole::Browser, b"browser-device-independent"),
    )
    .unwrap();
    let prepared = creator.prepare_add(&serialized_key_package).unwrap();
    assert!(!prepared.commit.is_empty());
    assert!(!prepared.welcome.is_empty());

    // Delivery Service acceptance happens before either endpoint advances.
    let mut creator = creator.accept_add().unwrap();
    let mut recipient = recipient.join(&prepared.welcome).unwrap();
    assert_eq!(creator.epoch(), recipient.epoch());

    // The establishment ACK is an MLS application message, so the creator
    // authenticates it with the newly established group instead of trusting
    // an unauthenticated HTTP flag.
    let ack_aad = aad(
        group_id,
        recipient.epoch(),
        b"owner-device-independent",
        b"group-established-ack-1",
    );
    let ack = recipient.encrypt(&ack_aad, b"GROUP_ESTABLISHED").unwrap();
    assert_eq!(
        creator.decrypt(&ack_aad, &ack).unwrap(),
        b"GROUP_ESTABLISHED"
    );

    let message_aad = aad(
        group_id,
        creator.epoch(),
        b"browser-device-independent",
        b"application-1",
    );
    let ciphertext = creator
        .encrypt(&message_aad, b"first message after authenticated ack")
        .unwrap();
    assert_eq!(
        recipient.decrypt(&message_aad, &ciphertext).unwrap(),
        b"first message after authenticated ack"
    );
}
