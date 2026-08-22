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
fn four_devices_join_and_revoked_device_cannot_read_the_new_epoch() {
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

    let third_endpoint = DirectRecipientEndpoint::new(&identity(
        DeviceRole::OwnerDevice,b"owner-principal",b"owner-device-3",
    )).unwrap();
    let before_third = creator.encrypt(&aad(creator.epoch(),b"before-third"),b"history stays private").unwrap();
    let third_add=creator.prepare_add_member(third_endpoint.serialized_key_package()).unwrap();
    first.apply_commit(&third_add.commit).unwrap();second.apply_commit(&third_add.commit).unwrap();
    creator.accept_pending_commit().unwrap();let mut third=third_endpoint.join(&third_add.welcome).unwrap();
    assert!(third.decrypt(&aad(creator.epoch()-1,b"before-third"),&before_third).is_err());

    let fourth_endpoint = DirectRecipientEndpoint::new(&identity(
        DeviceRole::OwnerDevice,b"owner-principal",b"owner-device-4",
    )).unwrap();
    let fourth_add=creator.prepare_add_member(fourth_endpoint.serialized_key_package()).unwrap();
    first.apply_commit(&fourth_add.commit).unwrap();second.apply_commit(&fourth_add.commit).unwrap();third.apply_commit(&fourth_add.commit).unwrap();
    creator.accept_pending_commit().unwrap();let mut fourth=fourth_endpoint.join(&fourth_add.welcome).unwrap();

    let attachment_aad=aad(creator.epoch(),b"attachment-after-four");
    let attachment=creator.encrypt(&attachment_aad,br#"{"type":"voko.e2ee.attachment-message/1","fileName":"four.png"}"#).unwrap();
    for member in [&mut first,&mut second,&mut third,&mut fourth] {
        assert_eq!(member.decrypt(&attachment_aad,&attachment).unwrap(),
          br#"{"type":"voko.e2ee.attachment-message/1","fileName":"four.png"}"#);
    }

    let removal = creator.prepare_remove_device(b"owner-device-1").unwrap();
    second.apply_commit(&removal).unwrap();
    third.apply_commit(&removal).unwrap();
    fourth.apply_commit(&removal).unwrap();
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
    assert_eq!(third.decrypt(&post_revoke_aad,&post_revoke).unwrap(),b"revoked device must not read");
    assert_eq!(fourth.decrypt(&post_revoke_aad,&post_revoke).unwrap(),b"revoked device must not read");
    assert!(first.decrypt(&post_revoke_aad, &post_revoke).is_err());
}
