use std::collections::HashMap;

use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Default)]
pub struct KeyPackageLedger {
    consumed: HashMap<[u8; 32], Vec<u8>>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum KeyPackageLedgerError {
    #[error("key package was already consumed by a different group")]
    Reused,
    #[error("group id is empty")]
    EmptyGroup,
    #[error("serialized key package is empty")]
    EmptyKeyPackage,
}

impl KeyPackageLedger {
    pub fn consume(
        &mut self,
        serialized_key_package: &[u8],
        group_id: &[u8],
    ) -> Result<[u8; 32], KeyPackageLedgerError> {
        if serialized_key_package.is_empty() {
            return Err(KeyPackageLedgerError::EmptyKeyPackage);
        }
        if group_id.is_empty() {
            return Err(KeyPackageLedgerError::EmptyGroup);
        }
        let reference: [u8; 32] = Sha256::digest(serialized_key_package).into();
        match self.consumed.get(&reference) {
            Some(existing) if existing.as_slice() != group_id => Err(KeyPackageLedgerError::Reused),
            Some(_) => Ok(reference),
            None => {
                self.consumed.insert(reference, group_id.to_vec());
                Ok(reference)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consumption_is_idempotent_for_one_group_and_rejects_cross_group_reuse() {
        let mut ledger = KeyPackageLedger::default();
        let first = ledger.consume(b"key-package", b"group-a").unwrap();
        assert_eq!(first, ledger.consume(b"key-package", b"group-a").unwrap());
        assert_eq!(
            ledger.consume(b"key-package", b"group-b"),
            Err(KeyPackageLedgerError::Reused)
        );
    }
}
