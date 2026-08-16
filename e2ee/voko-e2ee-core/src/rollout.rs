use std::collections::BTreeSet;

use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RolloutMode {
    Disabled,
    Shadow,
    Enabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConversationSecurityState {
    LegacyTransport,
    E2eeInitializing,
    E2eeActive,
    IdentityChanged,
    Locked,
    Revoked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RolloutDecision {
    LegacyTransport,
    ShadowMetadataOnly,
    EstablishE2ee,
    ContinueE2ee,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RolloutError {
    #[error("E2EE is required for this conversation but endpoint capability is unavailable")]
    CapabilityUnavailable,
    #[error("E2EE conversation is locked and cannot downgrade to plaintext")]
    PlaintextDowngradeForbidden,
    #[error("invalid E2EE rollout configuration")]
    InvalidConfiguration,
}

pub struct E2eeRolloutPolicy {
    mode: RolloutMode,
    agent_allowlist: BTreeSet<String>,
}

impl E2eeRolloutPolicy {
    pub fn new(
        mode: RolloutMode,
        agent_allowlist: impl IntoIterator<Item = String>,
    ) -> Result<Self, RolloutError> {
        let agent_allowlist: BTreeSet<_> = agent_allowlist.into_iter().collect();
        if agent_allowlist.iter().any(|agent| {
            agent.is_empty() || agent.len() > 2048 || agent.chars().any(char::is_control)
        }) {
            return Err(RolloutError::InvalidConfiguration);
        }
        if mode != RolloutMode::Disabled && agent_allowlist.is_empty() {
            return Err(RolloutError::InvalidConfiguration);
        }
        Ok(Self {
            mode,
            agent_allowlist,
        })
    }

    pub fn decide(
        &self,
        agent_did: &str,
        state: ConversationSecurityState,
        both_endpoints_capable: bool,
    ) -> Result<RolloutDecision, RolloutError> {
        let protected = matches!(
            state,
            ConversationSecurityState::E2eeInitializing
                | ConversationSecurityState::E2eeActive
                | ConversationSecurityState::IdentityChanged
                | ConversationSecurityState::Locked
                | ConversationSecurityState::Revoked
        );
        if protected && (!both_endpoints_capable || self.mode != RolloutMode::Enabled) {
            return Err(RolloutError::PlaintextDowngradeForbidden);
        }
        if matches!(
            state,
            ConversationSecurityState::IdentityChanged
                | ConversationSecurityState::Locked
                | ConversationSecurityState::Revoked
        ) {
            return Err(RolloutError::PlaintextDowngradeForbidden);
        }
        if state == ConversationSecurityState::E2eeActive {
            return Ok(RolloutDecision::ContinueE2ee);
        }
        if !self.agent_allowlist.contains(agent_did) {
            return Ok(RolloutDecision::LegacyTransport);
        }
        match self.mode {
            RolloutMode::Disabled => Ok(RolloutDecision::LegacyTransport),
            RolloutMode::Shadow => Ok(RolloutDecision::ShadowMetadataOnly),
            RolloutMode::Enabled if both_endpoints_capable => Ok(RolloutDecision::EstablishE2ee),
            RolloutMode::Enabled => Err(RolloutError::CapabilityUnavailable),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shadow_is_metadata_only_and_enabled_fails_closed() {
        let shadow =
            E2eeRolloutPolicy::new(RolloutMode::Shadow, ["did:voko:canary".into()]).unwrap();
        assert_eq!(
            shadow.decide(
                "did:voko:canary",
                ConversationSecurityState::LegacyTransport,
                true
            ),
            Ok(RolloutDecision::ShadowMetadataOnly)
        );
        let enabled =
            E2eeRolloutPolicy::new(RolloutMode::Enabled, ["did:voko:canary".into()]).unwrap();
        assert_eq!(
            enabled.decide(
                "did:voko:canary",
                ConversationSecurityState::LegacyTransport,
                false
            ),
            Err(RolloutError::CapabilityUnavailable)
        );
        assert_eq!(
            enabled.decide(
                "did:voko:canary",
                ConversationSecurityState::E2eeActive,
                false
            ),
            Err(RolloutError::PlaintextDowngradeForbidden)
        );
    }
}
