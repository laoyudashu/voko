use voko_e2ee_core::{AtomicStateStore, BoundedSecretCache};

fn run_group_scale(group_count: usize) {
    let mut store = AtomicStateStore::in_memory().unwrap();
    let mut cache = BoundedSecretCache::new(32, 32 * 128 * 1024).unwrap();
    for index in 0..group_count {
        let group_id = format!("scale-group-{index}");
        let message_id = format!("scale-bootstrap-{index}");
        let encrypted_state = vec![(index % 251) as u8; 2048];
        store
            .commit_prepared(
                &group_id,
                0,
                &encrypted_state,
                &message_id,
                b"fixed-bootstrap-ciphertext",
            )
            .unwrap();
        cache.insert(group_id, encrypted_state, 2048).unwrap();
        assert!(cache.len() <= 32);
        assert!(cache.used_bytes() <= 32 * 128 * 1024);
    }
    assert_eq!(cache.len(), 32);
}

#[test]
fn one_thousand_persisted_groups_keep_a_fixed_active_cache() {
    run_group_scale(1_000);
}

#[test]
#[ignore = "run through npm run test:e2ee:scale"]
fn ten_thousand_persisted_groups_keep_a_fixed_active_cache() {
    run_group_scale(10_000);
}
