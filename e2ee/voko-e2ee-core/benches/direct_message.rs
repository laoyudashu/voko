use criterion::{criterion_group, criterion_main, Criterion};
use voko_e2ee_core::{
    CanonicalAad, DirectGroupPair, KeyPackageLedger, E2EE_CONTENT_TYPE, E2EE_PROTOCOL_VERSION,
};

fn benchmark(c: &mut Criterion) {
    let mut pair = DirectGroupPair::establish(
        b"benchmark-group",
        b"benchmark-browser",
        b"benchmark-owner",
        &mut KeyPackageLedger::default(),
    )
    .unwrap();
    let aad = CanonicalAad {
        protocol_version: E2EE_PROTOCOL_VERSION,
        content_type: E2EE_CONTENT_TYPE,
        group_id: b"benchmark-group".to_vec(),
        epoch: 1,
        target_agent_did: b"did:voko:benchmark-agent".to_vec(),
        conversation_scope: b"benchmark-conversation".to_vec(),
        sender_device_key_id: b"benchmark-browser-key".to_vec(),
        message_id: b"benchmark-message".to_vec(),
        channel_type: 1,
    };

    c.bench_function("direct text encrypt", |b| {
        b.iter(|| pair.creator.encrypt(&aad, b"benchmark plaintext").unwrap())
    });
}

criterion_group!(benches, benchmark);
criterion_main!(benches);
