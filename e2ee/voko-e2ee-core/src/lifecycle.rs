use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EstablishmentState {
    CreatedLocal,
    KeyPackageReserved,
    AddCommitCreated,
    CommitAcceptedByDeliveryService,
    WelcomePersisted,
    RecipientJoined,
    GroupEstablished,
    Active,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EstablishmentEvent {
    ReserveKeyPackage,
    CreateAddCommit,
    AcceptCommit,
    PersistWelcome,
    JoinRecipient,
    AcknowledgeEstablished,
    Activate,
}

#[derive(Debug, Error, PartialEq, Eq)]
#[error("invalid establishment transition from {state:?} using {event:?}")]
pub struct LifecycleError {
    pub state: EstablishmentState,
    pub event: EstablishmentEvent,
}

impl EstablishmentState {
    pub fn apply(self, event: EstablishmentEvent) -> Result<Self, LifecycleError> {
        use EstablishmentEvent::*;
        use EstablishmentState::*;
        match (self, event) {
            (CreatedLocal, ReserveKeyPackage) => Ok(KeyPackageReserved),
            (KeyPackageReserved, CreateAddCommit) => Ok(AddCommitCreated),
            (AddCommitCreated, AcceptCommit) => Ok(CommitAcceptedByDeliveryService),
            (CommitAcceptedByDeliveryService, PersistWelcome) => Ok(WelcomePersisted),
            (WelcomePersisted, JoinRecipient) => Ok(RecipientJoined),
            (RecipientJoined, AcknowledgeEstablished) => Ok(GroupEstablished),
            (GroupEstablished, Activate) => Ok(Active),
            _ => Err(LifecycleError { state: self, event }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_delivery_acceptance_before_welcome_and_activation() {
        let state = EstablishmentState::CreatedLocal
            .apply(EstablishmentEvent::ReserveKeyPackage)
            .unwrap()
            .apply(EstablishmentEvent::CreateAddCommit)
            .unwrap();
        assert!(state.apply(EstablishmentEvent::PersistWelcome).is_err());
        let active = state
            .apply(EstablishmentEvent::AcceptCommit)
            .unwrap()
            .apply(EstablishmentEvent::PersistWelcome)
            .unwrap()
            .apply(EstablishmentEvent::JoinRecipient)
            .unwrap()
            .apply(EstablishmentEvent::AcknowledgeEstablished)
            .unwrap()
            .apply(EstablishmentEvent::Activate)
            .unwrap();
        assert_eq!(active, EstablishmentState::Active);
    }
}
