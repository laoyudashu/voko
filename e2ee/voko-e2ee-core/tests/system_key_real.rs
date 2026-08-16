use voko_e2ee_core::{SystemWrappingKeyStore, VaultKeyError, VaultKeyManager};

#[test]
#[ignore = "requires an unlocked OS credential store"]
fn real_system_credential_store_survives_reopen_and_revokes() {
    assert!(SystemWrappingKeyStore::is_available());
    let owner_scope = format!("e2ee-ci-{}-{}", std::process::id(), rand::random::<u64>());
    let manager = VaultKeyManager::new(SystemWrappingKeyStore);
    let provisioned = manager.provision(owner_scope.as_bytes()).unwrap();
    let ciphertext = provisioned
        .seal(b"system-key-ci-record", b"credential-store-secret")
        .unwrap();
    drop(provisioned);

    let reopened = VaultKeyManager::new(SystemWrappingKeyStore);
    let unlocked = reopened.unlock(owner_scope.as_bytes()).unwrap();
    assert_eq!(
        unlocked
            .open(b"system-key-ci-record", &ciphertext)
            .unwrap()
            .as_slice(),
        b"credential-store-secret"
    );
    reopened.revoke(owner_scope.as_bytes()).unwrap();
    assert!(matches!(
        reopened.unlock(owner_scope.as_bytes()),
        Err(VaultKeyError::NotProvisioned)
    ));
}
