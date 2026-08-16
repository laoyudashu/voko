use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectoryKeyEntry {
    pub identity_scope: Vec<u8>,
    pub device_key_id: Vec<u8>,
    pub key_epoch: u64,
    pub credential_public_key: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransparencyCheckpoint {
    pub tree_size: u64,
    pub root_hash: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WitnessedCheckpoint {
    pub witness_key: [u8; 32],
    pub signature: [u8; 64],
}

pub struct TransparencyLog {
    leaves: Vec<[u8; 32]>,
}

pub struct TransparencyWitness {
    signer: SigningKey,
    observed_leaves: Vec<[u8; 32]>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TransparencyError {
    #[error("invalid key transparency entry or proof")]
    InvalidProof,
    #[error("key transparency log is not append-only")]
    SplitView,
    #[error("insufficient independent witnesses")]
    InsufficientWitnesses,
}

impl DirectoryKeyEntry {
    pub fn leaf_hash(&self) -> Result<[u8; 32], TransparencyError> {
        let mut bytes = Vec::with_capacity(128);
        bytes.extend_from_slice(b"voko.key.transparency/1\0");
        for value in [
            &self.identity_scope,
            &self.device_key_id,
            &self.credential_public_key,
        ] {
            if value.is_empty() || value.len() > 4096 {
                return Err(TransparencyError::InvalidProof);
            }
            bytes.extend_from_slice(&(value.len() as u32).to_be_bytes());
            bytes.extend_from_slice(value);
        }
        bytes.extend_from_slice(&self.key_epoch.to_be_bytes());
        Ok(leaf_hash(&bytes))
    }
}

impl TransparencyLog {
    pub fn new() -> Self {
        Self { leaves: Vec::new() }
    }

    pub fn append(&mut self, entry: &DirectoryKeyEntry) -> Result<u64, TransparencyError> {
        self.leaves.push(entry.leaf_hash()?);
        Ok(self.leaves.len() as u64 - 1)
    }

    pub fn checkpoint(&self) -> TransparencyCheckpoint {
        TransparencyCheckpoint {
            tree_size: self.leaves.len() as u64,
            root_hash: merkle_root(&self.leaves),
        }
    }

    pub fn inclusion_proof(&self, leaf_index: usize) -> Result<Vec<[u8; 32]>, TransparencyError> {
        if leaf_index >= self.leaves.len() {
            return Err(TransparencyError::InvalidProof);
        }
        let mut level = self.leaves.clone();
        let mut index = leaf_index;
        let mut proof = Vec::new();
        while level.len() > 1 {
            let sibling = if index % 2 == 0 {
                (index + 1).min(level.len() - 1)
            } else {
                index - 1
            };
            proof.push(level[sibling]);
            level = next_level(&level);
            index /= 2;
        }
        Ok(proof)
    }
}

impl TransparencyWitness {
    pub fn new() -> Self {
        let mut seed = [0u8; 32];
        OsRng.fill_bytes(&mut seed);
        Self {
            signer: SigningKey::from_bytes(&seed),
            observed_leaves: Vec::new(),
        }
    }

    pub fn observe(
        &mut self,
        log: &TransparencyLog,
    ) -> Result<WitnessedCheckpoint, TransparencyError> {
        if log.leaves.len() < self.observed_leaves.len()
            || log.leaves[..self.observed_leaves.len()] != self.observed_leaves
        {
            return Err(TransparencyError::SplitView);
        }
        self.observed_leaves = log.leaves.clone();
        let checkpoint = log.checkpoint();
        let signature = self.signer.sign(&checkpoint_bytes(&checkpoint)).to_bytes();
        Ok(WitnessedCheckpoint {
            witness_key: self.signer.verifying_key().to_bytes(),
            signature,
        })
    }
}

pub fn verify_inclusion(
    entry: &DirectoryKeyEntry,
    leaf_index: usize,
    checkpoint: &TransparencyCheckpoint,
    proof: &[[u8; 32]],
) -> Result<(), TransparencyError> {
    if checkpoint.tree_size == 0 || leaf_index >= checkpoint.tree_size as usize {
        return Err(TransparencyError::InvalidProof);
    }
    let mut hash = entry.leaf_hash()?;
    let mut index = leaf_index;
    for sibling in proof {
        hash = if index % 2 == 0 {
            node_hash(&hash, sibling)
        } else {
            node_hash(sibling, &hash)
        };
        index /= 2;
    }
    if hash != checkpoint.root_hash {
        return Err(TransparencyError::InvalidProof);
    }
    Ok(())
}

pub fn verify_witnesses(
    checkpoint: &TransparencyCheckpoint,
    witnesses: &[WitnessedCheckpoint],
    trusted_witness_keys: &[[u8; 32]],
    minimum: usize,
) -> Result<(), TransparencyError> {
    let mut valid = std::collections::BTreeSet::new();
    for witness in witnesses {
        if !trusted_witness_keys.contains(&witness.witness_key) {
            continue;
        }
        let Ok(key) = VerifyingKey::from_bytes(&witness.witness_key) else {
            continue;
        };
        let signature = Signature::from_bytes(&witness.signature);
        if key
            .verify(&checkpoint_bytes(checkpoint), &signature)
            .is_ok()
        {
            valid.insert(witness.witness_key);
        }
    }
    if valid.len() < minimum {
        return Err(TransparencyError::InsufficientWitnesses);
    }
    Ok(())
}

fn checkpoint_bytes(checkpoint: &TransparencyCheckpoint) -> Vec<u8> {
    let mut bytes = b"voko.transparency.checkpoint/1\0".to_vec();
    bytes.extend_from_slice(&checkpoint.tree_size.to_be_bytes());
    bytes.extend_from_slice(&checkpoint.root_hash);
    bytes
}

fn leaf_hash(bytes: &[u8]) -> [u8; 32] {
    let mut input = Vec::with_capacity(bytes.len() + 1);
    input.push(0);
    input.extend_from_slice(bytes);
    Sha256::digest(input).into()
}

fn node_hash(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut input = Vec::with_capacity(65);
    input.push(1);
    input.extend_from_slice(left);
    input.extend_from_slice(right);
    Sha256::digest(input).into()
}

fn next_level(level: &[[u8; 32]]) -> Vec<[u8; 32]> {
    level
        .chunks(2)
        .map(|pair| node_hash(&pair[0], pair.get(1).unwrap_or(&pair[0])))
        .collect()
}

fn merkle_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    if leaves.is_empty() {
        return Sha256::digest(b"voko.transparency.empty/1").into();
    }
    let mut level = leaves.to_vec();
    while level.len() > 1 {
        level = next_level(&level);
    }
    level[0]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(epoch: u64) -> DirectoryKeyEntry {
        DirectoryKeyEntry {
            identity_scope: b"owner-device-scope".to_vec(),
            device_key_id: format!("device-{epoch}").into_bytes(),
            key_epoch: epoch,
            credential_public_key: vec![epoch as u8; 32],
        }
    }

    #[test]
    fn inclusion_and_two_independent_witnesses_verify() {
        let mut log = TransparencyLog::new();
        log.append(&entry(1)).unwrap();
        log.append(&entry(2)).unwrap();
        let checkpoint = log.checkpoint();
        verify_inclusion(&entry(2), 1, &checkpoint, &log.inclusion_proof(1).unwrap()).unwrap();
        let mut first = TransparencyWitness::new();
        let mut second = TransparencyWitness::new();
        let first_signed = first.observe(&log).unwrap();
        let second_signed = second.observe(&log).unwrap();
        verify_witnesses(
            &checkpoint,
            &[first_signed.clone(), second_signed.clone()],
            &[first_signed.witness_key, second_signed.witness_key],
            2,
        )
        .unwrap();
    }

    #[test]
    fn witness_rejects_a_rewritten_prefix() {
        let mut witness = TransparencyWitness::new();
        let mut original = TransparencyLog::new();
        original.append(&entry(1)).unwrap();
        witness.observe(&original).unwrap();
        let mut fork = TransparencyLog::new();
        fork.append(&entry(9)).unwrap();
        assert_eq!(witness.observe(&fork), Err(TransparencyError::SplitView));
    }
}
