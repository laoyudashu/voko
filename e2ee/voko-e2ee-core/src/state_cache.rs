use std::collections::{HashMap, VecDeque};
use std::hash::Hash;

use thiserror::Error;
use zeroize::Zeroize;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CacheError {
    #[error("cache limits must be greater than zero")]
    InvalidLimit,
    #[error("entry exceeds the cache byte limit")]
    EntryTooLarge,
}

pub struct BoundedSecretCache<K, V>
where
    K: Eq + Hash + Clone,
    V: Zeroize,
{
    entries: HashMap<K, (V, usize)>,
    order: VecDeque<K>,
    max_entries: usize,
    max_bytes: usize,
    used_bytes: usize,
}

impl<K, V> BoundedSecretCache<K, V>
where
    K: Eq + Hash + Clone,
    V: Zeroize,
{
    pub fn new(max_entries: usize, max_bytes: usize) -> Result<Self, CacheError> {
        if max_entries == 0 || max_bytes == 0 {
            return Err(CacheError::InvalidLimit);
        }
        Ok(Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            max_entries,
            max_bytes,
            used_bytes: 0,
        })
    }

    pub fn insert(&mut self, key: K, value: V, bytes: usize) -> Result<(), CacheError> {
        if bytes > self.max_bytes {
            return Err(CacheError::EntryTooLarge);
        }
        self.remove(&key);
        self.entries.insert(key.clone(), (value, bytes));
        self.order.push_back(key);
        self.used_bytes += bytes;
        self.evict_to_limits();
        Ok(())
    }

    pub fn get(&mut self, key: &K) -> Option<&V> {
        if self.entries.contains_key(key) {
            self.order.retain(|candidate| candidate != key);
            self.order.push_back(key.clone());
        }
        self.entries.get(key).map(|(value, _)| value)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn used_bytes(&self) -> usize {
        self.used_bytes
    }

    fn remove(&mut self, key: &K) {
        if let Some((mut value, bytes)) = self.entries.remove(key) {
            value.zeroize();
            self.used_bytes = self.used_bytes.saturating_sub(bytes);
        }
        self.order.retain(|candidate| candidate != key);
    }

    fn evict_to_limits(&mut self) {
        while self.entries.len() > self.max_entries || self.used_bytes > self.max_bytes {
            if let Some(key) = self.order.pop_front() {
                if let Some((mut value, bytes)) = self.entries.remove(&key) {
                    value.zeroize();
                    self.used_bytes = self.used_bytes.saturating_sub(bytes);
                }
            } else {
                break;
            }
        }
    }
}

impl<K, V> Drop for BoundedSecretCache<K, V>
where
    K: Eq + Hash + Clone,
    V: Zeroize,
{
    fn drop(&mut self) {
        for (value, _) in self.entries.values_mut() {
            value.zeroize();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evicts_by_count_and_bytes_in_lru_order() {
        let mut cache = BoundedSecretCache::new(2, 8).unwrap();
        cache.insert("a", vec![1u8; 4], 4).unwrap();
        cache.insert("b", vec![2u8; 4], 4).unwrap();
        assert!(cache.get(&"a").is_some());
        cache.insert("c", vec![3u8; 4], 4).unwrap();
        assert!(cache.get(&"b").is_none());
        assert!(cache.get(&"a").is_some());
        assert!(cache.get(&"c").is_some());
        assert_eq!(cache.len(), 2);
        assert_eq!(cache.used_bytes(), 8);
    }

    #[test]
    fn rejects_an_entry_larger_than_the_byte_budget() {
        let mut cache = BoundedSecretCache::new(2, 4).unwrap();
        assert_eq!(
            cache.insert("a", vec![0u8; 5], 5),
            Err(CacheError::EntryTooLarge)
        );
    }
}
