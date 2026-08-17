use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use voko_e2ee_core::{AttachmentKey, EncryptedAttachment, MAX_ATTACHMENT_BYTES};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    file_id: String,
    nonce_prefix: String,
    plaintext_size: u64,
    chunk_size: u32,
    ciphertext_hashes: Vec<String>,
}

fn argument(name: &str) -> Result<PathBuf, String> {
    let value = std::env::args()
        .find_map(|arg| arg.strip_prefix(&format!("--{name}=")).map(str::to_owned))
        .filter(|value| {
            !value.is_empty() && value.len() <= 4096 && !value.chars().any(char::is_control)
        })
        .ok_or_else(|| format!("missing --{name}"))?;
    Ok(PathBuf::from(value))
}

fn chunk_path(directory: &Path, index: usize) -> PathBuf {
    directory.join(format!("chunk-{index:04}.bin"))
}

fn fixed<const N: usize>(value: &str) -> Result<[u8; N], String> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| "invalid manifest encoding".to_string())?
        .try_into()
        .map_err(|_| "invalid manifest length".to_string())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), String> {
    let operation = std::env::args().nth(1).ok_or("missing operation")?;
    let input = argument("input")?;
    let directory = argument("directory")?;
    let key_path = argument("key")?;
    match operation.as_str() {
        "encrypt" => {
            let plaintext = fs::read(&input).map_err(|_| "attachment input unavailable")?;
            if plaintext.is_empty() || plaintext.len() > MAX_ATTACHMENT_BYTES {
                return Err("attachment size rejected".into());
            }
            fs::create_dir_all(&directory).map_err(|_| "ciphertext directory unavailable")?;
            let key = AttachmentKey::generate();
            let encrypted = EncryptedAttachment::encrypt(&plaintext, &key)
                .map_err(|error| error.to_string())?;
            fs::write(&key_path, key.expose_for_mls()).map_err(|_| "key output unavailable")?;
            for (index, chunk) in encrypted.chunks.iter().enumerate() {
                fs::write(chunk_path(&directory, index), chunk)
                    .map_err(|_| "chunk output unavailable")?;
            }
            let manifest = Manifest {
                file_id: URL_SAFE_NO_PAD.encode(encrypted.file_id),
                nonce_prefix: URL_SAFE_NO_PAD.encode(encrypted.nonce_prefix),
                plaintext_size: encrypted.plaintext_size,
                chunk_size: encrypted.chunk_size,
                ciphertext_hashes: encrypted
                    .ciphertext_hashes
                    .iter()
                    .map(|hash| URL_SAFE_NO_PAD.encode(hash))
                    .collect(),
            };
            fs::write(
                directory.join("manifest.json"),
                serde_json::to_vec(&manifest).map_err(|_| "manifest encode failed")?,
            )
            .map_err(|_| "manifest output unavailable")?;
            println!("{{\"success\":true,\"chunks\":{}}}", encrypted.chunks.len());
        }
        "decrypt" => {
            let manifest: Manifest = serde_json::from_slice(
                &fs::read(directory.join("manifest.json")).map_err(|_| "manifest unavailable")?,
            )
            .map_err(|_| "manifest invalid")?;
            if manifest.ciphertext_hashes.is_empty() || manifest.ciphertext_hashes.len() > 25 {
                return Err("manifest chunk count rejected".into());
            }
            let chunks = (0..manifest.ciphertext_hashes.len())
                .map(|index| {
                    fs::read(chunk_path(&directory, index))
                        .map_err(|_| "ciphertext chunk unavailable".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;
            let encrypted = EncryptedAttachment {
                file_id: fixed(&manifest.file_id)?,
                nonce_prefix: fixed(&manifest.nonce_prefix)?,
                plaintext_size: manifest.plaintext_size,
                chunk_size: manifest.chunk_size,
                ciphertext_hashes: manifest
                    .ciphertext_hashes
                    .iter()
                    .map(|value| fixed(value))
                    .collect::<Result<Vec<_>, _>>()?,
                chunks,
            };
            let key = AttachmentKey::from_bytes(
                &fs::read(&key_path).map_err(|_| "attachment key unavailable")?,
            )
            .map_err(|error| error.to_string())?;
            let plaintext = encrypted.decrypt(&key).map_err(|error| error.to_string())?;
            fs::write(&input, plaintext.as_slice()).map_err(|_| "plaintext output unavailable")?;
            println!("{{\"success\":true,\"bytes\":{}}}", plaintext.len());
        }
        _ => return Err("operation must be encrypt or decrypt".into()),
    }
    Ok(())
}
