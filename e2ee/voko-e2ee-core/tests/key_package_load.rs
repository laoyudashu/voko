use std::{collections::BTreeSet, time::Instant};

use sha2::{Digest, Sha256};
use voko_e2ee_core::{DeviceCredentialIdentity, DeviceRole, DirectRecipientEndpoint};

#[test]
fn bounded_idle_batch_generates_unique_key_packages() {
    let started = Instant::now();
    let mut references = BTreeSet::new();
    for index in 0..20u64 {
        let endpoint = DirectRecipientEndpoint::new(&DeviceCredentialIdentity {
            role: DeviceRole::OwnerDevice,
            principal_id: b"key-package-load-owner".to_vec(),
            device_key_id: format!("key-package-device-{index}").into_bytes(),
            key_epoch: 1,
            target_agent_did: b"did:voko:key-package-load-agent".to_vec(),
        }).unwrap();
        references.insert(<[u8; 32]>::from(Sha256::digest(endpoint.serialized_key_package())));
    }
    assert_eq!(references.len(), 20);
    assert!(started.elapsed().as_secs() < 10, "bounded KeyPackage batch exceeded 10 seconds");
}
