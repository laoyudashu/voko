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
    #[error("invalid key package replenishment policy")]
    InvalidReplenishmentPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyPackageReplenishmentPolicy {
    pub low_watermark: usize,
    pub target: usize,
    pub max_per_idle_cycle: usize,
}

impl KeyPackageReplenishmentPolicy {
    pub fn new(low_watermark: usize, target: usize, max_per_idle_cycle: usize) -> Result<Self, KeyPackageLedgerError> {
        if low_watermark == 0 || target < low_watermark || max_per_idle_cycle == 0 {
            return Err(KeyPackageLedgerError::InvalidReplenishmentPolicy);
        }
        Ok(Self { low_watermark, target, max_per_idle_cycle })
    }

    /// Returns bounded work for an idle cycle. Key generation is never
    /// scheduled on the message send path and in-flight work counts toward the
    /// target so concurrent workers cannot create an unbounded burst.
    pub fn plan(&self, available: usize, in_flight: usize, idle: bool) -> usize {
        let total = available.saturating_add(in_flight);
        if !idle || total >= self.low_watermark { return 0; }
        self.target.saturating_sub(total).min(self.max_per_idle_cycle)
    }
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

    #[test]
    fn replenishment_is_idle_only_and_bounded_per_cycle() {
        let policy = KeyPackageReplenishmentPolicy::new(4, 12, 3).unwrap();
        assert_eq!(policy.plan(3, 0, false), 0);
        assert_eq!(policy.plan(4, 0, true), 0);
        assert_eq!(policy.plan(1, 0, true), 3);
        assert_eq!(policy.plan(1, 8, true), 0);
        assert_eq!(policy.plan(0, usize::MAX, true), 0);
        assert_eq!(KeyPackageReplenishmentPolicy::new(0, 1, 1), Err(KeyPackageLedgerError::InvalidReplenishmentPolicy));
    }
}
