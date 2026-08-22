use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Write};
use voko_e2ee_core::{DirectoryKeyEntry, TransparencyLog, TransparencyWitness};

const MAX_ENTRIES: usize = 10_000;
const MAX_LINE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    identity_scope: String,
    device_key_id: String,
    key_epoch: u64,
    credential_public_key: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    entries: Vec<Entry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    ok: bool,
    tree_size: Option<u64>,
    root_hash: Option<String>,
    witness_key: Option<String>,
    signature: Option<String>,
    error: Option<&'static str>,
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}

fn respond(response: &Response) {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, response).expect("serialize witness response");
    stdout.write_all(b"\n").expect("write witness response");
    stdout.flush().expect("flush witness response");
}

fn main() {
    let mut witness = TransparencyWitness::new();
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.len() > MAX_LINE_BYTES {
            respond(&Response { ok: false, tree_size: None, root_hash: None, witness_key: None, signature: None, error: Some("invalid_request") });
            continue;
        }
        let Ok(request) = serde_json::from_str::<Request>(&line) else {
            respond(&Response { ok: false, tree_size: None, root_hash: None, witness_key: None, signature: None, error: Some("invalid_request") });
            continue;
        };
        if request.entries.is_empty() || request.entries.len() > MAX_ENTRIES {
            respond(&Response { ok: false, tree_size: None, root_hash: None, witness_key: None, signature: None, error: Some("invalid_request") });
            continue;
        }
        let mut log = TransparencyLog::new();
        let valid = request.entries.into_iter().all(|entry| log.append(&DirectoryKeyEntry {
            identity_scope: entry.identity_scope.into_bytes(),
            device_key_id: entry.device_key_id.into_bytes(),
            key_epoch: entry.key_epoch,
            credential_public_key: entry.credential_public_key.into_bytes(),
        }).is_ok());
        if !valid {
            respond(&Response { ok: false, tree_size: None, root_hash: None, witness_key: None, signature: None, error: Some("invalid_request") });
            continue;
        }
        match witness.observe(&log) {
            Ok(signed) => {
                let checkpoint = log.checkpoint();
                respond(&Response {
                    ok: true,
                    tree_size: Some(checkpoint.tree_size),
                    root_hash: Some(hex(&checkpoint.root_hash)),
                    witness_key: Some(hex(&signed.witness_key)),
                    signature: Some(hex(&signed.signature)),
                    error: None,
                });
            }
            Err(_) => respond(&Response { ok: false, tree_size: None, root_hash: None, witness_key: None, signature: None, error: Some("split_view") }),
        }
    }
}
