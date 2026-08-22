use voko_e2ee_core::{
    CanonicalAad, DeviceCredentialIdentity, DeviceRole, DirectCreatorEndpoint,
    DirectRecipientEndpoint, E2EE_CONTENT_TYPE, E2EE_PROTOCOL_VERSION,
};

fn identity(role: DeviceRole, principal: &[u8], device: &[u8]) -> DeviceCredentialIdentity {
    DeviceCredentialIdentity {
        role,
        principal_id: principal.to_vec(),
        device_key_id: device.to_vec(),
        key_epoch: 1,
        target_agent_did: b"did:voko:multi-device-agent".to_vec(),
    }
}

fn aad(epoch: u64, message: &[u8]) -> CanonicalAad {
    CanonicalAad {
        protocol_version: E2EE_PROTOCOL_VERSION,
        content_type: E2EE_CONTENT_TYPE,
        group_id: b"multi-device-group".to_vec(),
        epoch,
        target_agent_did: b"did:voko:multi-device-agent".to_vec(),
        conversation_scope: b"multi-device-conversation".to_vec(),
        sender_device_key_id: b"browser-multi".to_vec(),
        message_id: message.to_vec(),
        channel_type: 1,
    }
}

#[test]
fn second_device_joins_and_revoked_device_cannot_read_the_new_epoch() {
    let first_endpoint = DirectRecipientEndpoint::new(&identity(
        DeviceRole::OwnerDevice,
        b"owner-principal",
        b"owner-device-1",
    ))
    .unwrap();
    let mut creator_endpoint = DirectCreatorEndpoint::new(
        b"multi-device-group",
        &identity(DeviceRole::Browser, b"guest-principal", b"browser-multi"),
    )
    .unwrap();
    let first_add = creator_endpoint
        .prepare_add(first_endpoint.serialized_key_package())
        .unwrap();
    let mut creator = creator_endpoint.accept_add().unwrap();
    let mut first = first_endpoint.join(&first_add.welcome).unwrap();

    let second_endpoint = DirectRecipientEndpoint::new(&identity(
        DeviceRole::OwnerDevice,
        b"owner-principal",
        b"owner-device-2",
    ))
    .unwrap();
    let second_add = creator
        .prepare_add_member(second_endpoint.serialized_key_package())
        .unwrap();
    first.apply_commit(&second_add.commit).unwrap();
    creator.accept_pending_commit().unwrap();
    let mut second = second_endpoint.join(&second_add.welcome).unwrap();

    let shared_aad = aad(creator.epoch(), b"all-devices-1");
    let shared = creator
        .encrypt(&shared_aad, b"visible on both devices")
        .unwrap();
    assert_eq!(
        first.decrypt(&shared_aad, &shared).unwrap(),
        b"visible on both devices"
    );
    assert_eq!(
        second.decrypt(&shared_aad, &shared).unwrap(),
        b"visible on both devices"
    );

    let removal = creator.prepare_remove_device(b"owner-device-1").unwrap();
    second.apply_commit(&removal).unwrap();
    creator.accept_pending_commit().unwrap();
    assert_eq!(creator.epoch(), second.epoch());

    let post_revoke_aad = aad(creator.epoch(), b"after-revoke-1");
    let post_revoke = creator
        .encrypt(&post_revoke_aad, b"revoked device must not read")
        .unwrap();
    assert_eq!(
        second.decrypt(&post_revoke_aad, &post_revoke).unwrap(),
        b"revoked device must not read"
    );
    assert!(first.decrypt(&post_revoke_aad, &post_revoke).is_err());
}
