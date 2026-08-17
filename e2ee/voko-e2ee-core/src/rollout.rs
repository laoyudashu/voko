use std::collections::BTreeSet;

use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct CanaryScope {
    pub owner_principal_id: String,
    pub agent_did: String,
    pub device_key_id: String,
}

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
    canary_allowlist: BTreeSet<CanaryScope>,
}

impl E2eeRolloutPolicy {
    pub fn new(
        mode: RolloutMode,
        canary_allowlist: impl IntoIterator<Item = CanaryScope>,
    ) -> Result<Self, RolloutError> {
        let canary_allowlist: BTreeSet<_> = canary_allowlist.into_iter().collect();
        if canary_allowlist.iter().any(|scope| {
            [
                &scope.owner_principal_id,
                &scope.agent_did,
                &scope.device_key_id,
            ]
            .into_iter()
            .any(|value| {
                value.is_empty() || value.len() > 2048 || value.chars().any(char::is_control)
            })
        }) {
            return Err(RolloutError::InvalidConfiguration);
        }
        if mode != RolloutMode::Disabled && canary_allowlist.is_empty() {
            return Err(RolloutError::InvalidConfiguration);
        }
        Ok(Self {
            mode,
            canary_allowlist,
        })
    }

    pub fn decide(
        &self,
        scope: &CanaryScope,
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
        if protected
            && (!both_endpoints_capable
                || self.mode != RolloutMode::Enabled
                || !self.canary_allowlist.contains(scope))
        {
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
        if !self.canary_allowlist.contains(scope) {
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
        let scope = CanaryScope {
            owner_principal_id: "owner-canary".into(),
            agent_did: "did:voko:canary".into(),
            device_key_id: "device-canary".into(),
        };
        let shadow = E2eeRolloutPolicy::new(RolloutMode::Shadow, [scope.clone()]).unwrap();
        assert_eq!(
            shadow.decide(&scope, ConversationSecurityState::LegacyTransport, true),
            Ok(RolloutDecision::ShadowMetadataOnly)
        );
        let enabled = E2eeRolloutPolicy::new(RolloutMode::Enabled, [scope.clone()]).unwrap();
        assert_eq!(
            enabled.decide(&scope, ConversationSecurityState::LegacyTransport, false),
            Err(RolloutError::CapabilityUnavailable)
        );
        assert_eq!(
            enabled.decide(&scope, ConversationSecurityState::E2eeActive, false),
            Err(RolloutError::PlaintextDowngradeForbidden)
        );

        for rejected in [
            CanaryScope {
                owner_principal_id: "other-owner".into(),
                ..scope.clone()
            },
            CanaryScope {
                agent_did: "did:voko:other".into(),
                ..scope.clone()
            },
            CanaryScope {
                device_key_id: "other-device".into(),
                ..scope.clone()
            },
        ] {
            assert_eq!(
                enabled.decide(&rejected, ConversationSecurityState::LegacyTransport, true),
                Ok(RolloutDecision::LegacyTransport)
            );
        }
    }

    #[test]
    fn active_conversation_stops_when_scope_is_removed_or_global_mode_is_disabled() {
        let scope = CanaryScope {
            owner_principal_id: "owner-canary".into(),
            agent_did: "did:voko:canary".into(),
            device_key_id: "device-canary".into(),
        };
        let other = CanaryScope {
            device_key_id: "other-device".into(),
            ..scope.clone()
        };
        let removed = E2eeRolloutPolicy::new(RolloutMode::Enabled, [other]).unwrap();
        assert_eq!(
            removed.decide(&scope, ConversationSecurityState::E2eeActive, true),
            Err(RolloutError::PlaintextDowngradeForbidden)
        );

        let disabled = E2eeRolloutPolicy::new(RolloutMode::Disabled, []).unwrap();
        assert_eq!(
            disabled.decide(&scope, ConversationSecurityState::E2eeActive, true),
            Err(RolloutError::PlaintextDowngradeForbidden)
        );
    }
}
