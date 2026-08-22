#![cfg(not(target_arch = "wasm32"))]

use voko_e2ee_core::{
    AtomicStateStore, DeliveryKind, DirectGroup, DirectGroupPair, KeyPackageLedger, RecordVault,
};

#[test]
fn pending_self_update_recovers_and_reuses_one_commit_after_crash() {
    let mut pair = DirectGroupPair::establish(
        b"pcs-recovery-group",
        b"pcs-browser",
        b"pcs-owner",
        &mut KeyPackageLedger::default(),
    )
    .unwrap();
    let prior_epoch = pair.creator.epoch();
    let commit = pair.creator.prepare_self_update().unwrap();
    let vault = RecordVault::from_master_key(&[11u8; 32]).unwrap();
    let sealed_pending = vault
        .seal(
            b"pcs-recovery/pending-state",
            &pair.creator.snapshot().unwrap(),
        )
        .unwrap();
    let path = std::env::temp_dir().join(format!(
        "voko-e2ee-pcs-{}-{}.db",
        std::process::id(),
        rand::random::<u64>()
    ));
    {
        let mut store = AtomicStateStore::open(&path).unwrap();
        let prepared = store
            .commit_prepared_kind(
                "pcs-recovery-group",
                0,
                &sealed_pending,
                "pcs-commit-1",
                &commit,
                DeliveryKind::Commit,
            )
            .unwrap();
        assert_eq!(prepared.kind, DeliveryKind::Commit);
        let claimed = store
            .claim_next("worker-before-crash", 100, 10)
            .unwrap()
            .unwrap();
        assert_eq!(claimed.delivery.ciphertext, commit);
    }

    let mut restored = {
        let mut store = AtomicStateStore::open(&path).unwrap();
        let (_, sealed_state) = store
            .encrypted_group_state("pcs-recovery-group")
            .unwrap()
            .unwrap();
        let pending_state = vault
            .open(b"pcs-recovery/pending-state", &sealed_state)
            .unwrap();
        let mut restored = DirectGroup::restore(&pending_state).unwrap();
        assert_eq!(restored.epoch(), prior_epoch);
        assert!(restored.prepare_self_update().is_err());
        let retry = store
            .claim_next("worker-after-crash", 110, 10)
            .unwrap()
            .unwrap();
        assert_eq!(retry.delivery.kind, DeliveryKind::Commit);
        assert_eq!(retry.delivery.ciphertext, commit);
        store
            .mark_sent("pcs-commit-1", "worker-after-crash")
            .unwrap();
        restored
    };

    restored.accept_pending_self_update().unwrap();
    pair.recipient.apply_self_update(&commit).unwrap();
    assert_eq!(restored.epoch(), prior_epoch + 1);
    assert_eq!(pair.recipient.epoch(), prior_epoch + 1);
    let _ = std::fs::remove_file(path);
}
