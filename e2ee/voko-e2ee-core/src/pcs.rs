use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PcsUpdatePolicy {
    pub max_messages: u64,
    pub max_age_ms: u64,
}

impl Default for PcsUpdatePolicy {
    fn default() -> Self {
        Self {
            max_messages: 1_000,
            max_age_ms: 24 * 60 * 60 * 1_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PcsUpdateTracker {
    policy: PcsUpdatePolicy,
    messages_since_update: u64,
    updated_at_ms: u64,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PcsPolicyError {
    #[error("PCS update policy limits must be non-zero")]
    InvalidPolicy,
    #[error("PCS update clock moved backwards")]
    ClockRollback,
}

impl PcsUpdateTracker {
    pub fn new(policy: PcsUpdatePolicy, now_ms: u64) -> Result<Self, PcsPolicyError> {
        if policy.max_messages == 0 || policy.max_age_ms == 0 {
            return Err(PcsPolicyError::InvalidPolicy);
        }
        Ok(Self {
            policy,
            messages_since_update: 0,
            updated_at_ms: now_ms,
        })
    }

    pub fn observe_message(&mut self) {
        self.messages_since_update = self.messages_since_update.saturating_add(1);
    }

    pub fn update_required(
        &self,
        now_ms: u64,
        security_event: bool,
    ) -> Result<bool, PcsPolicyError> {
        let age = now_ms
            .checked_sub(self.updated_at_ms)
            .ok_or(PcsPolicyError::ClockRollback)?;
        Ok(security_event
            || self.messages_since_update >= self.policy.max_messages
            || age >= self.policy.max_age_ms)
    }

    pub fn mark_accepted(&mut self, now_ms: u64) -> Result<(), PcsPolicyError> {
        if now_ms < self.updated_at_ms {
            return Err(PcsPolicyError::ClockRollback);
        }
        self.messages_since_update = 0;
        self.updated_at_ms = now_ms;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_time_and_security_events_trigger_updates() {
        let policy = PcsUpdatePolicy {
            max_messages: 2,
            max_age_ms: 100,
        };
        let mut tracker = PcsUpdateTracker::new(policy, 1_000).unwrap();
        tracker.observe_message();
        assert!(!tracker.update_required(1_050, false).unwrap());
        tracker.observe_message();
        assert!(tracker.update_required(1_050, false).unwrap());
        tracker.mark_accepted(1_050).unwrap();
        assert!(tracker.update_required(1_150, false).unwrap());
        tracker.mark_accepted(1_150).unwrap();
        assert!(tracker.update_required(1_151, true).unwrap());
        assert_eq!(
            tracker.update_required(1_149, false),
            Err(PcsPolicyError::ClockRollback)
        );
    }
}
