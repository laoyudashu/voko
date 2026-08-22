use thiserror::Error;

const MAGIC: &[u8; 13] = b"VOKO-CRED-001";
const MAX_FIELD: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum DeviceRole {
    Browser = 1,
    OwnerDevice = 2,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceCredentialIdentity {
    pub role: DeviceRole,
    pub principal_id: Vec<u8>,
    pub device_key_id: Vec<u8>,
    pub key_epoch: u64,
    pub target_agent_did: Vec<u8>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CredentialIdentityError {
    #[error("credential field is empty: {0}")]
    Empty(&'static str),
    #[error("credential field is too large: {0}")]
    TooLarge(&'static str),
    #[error("invalid credential encoding")]
    InvalidEncoding,
    #[error("creator and recipient credentials are not authorized for the same Agent DID")]
    AgentMismatch,
    #[error("direct group requires a browser creator and owner-device recipient")]
    RoleMismatch,
}

impl DeviceCredentialIdentity {
    pub fn encode(&self) -> Result<Vec<u8>, CredentialIdentityError> {
        let mut output = Vec::with_capacity(128);
        output.extend_from_slice(MAGIC);
        output.push(self.role as u8);
        put(&mut output, "principal_id", &self.principal_id)?;
        put(&mut output, "device_key_id", &self.device_key_id)?;
        output.extend_from_slice(&self.key_epoch.to_be_bytes());
        put(&mut output, "target_agent_did", &self.target_agent_did)?;
        Ok(output)
    }

    pub fn decode(input: &[u8]) -> Result<Self, CredentialIdentityError> {
        if !input.starts_with(MAGIC) {
            return Err(CredentialIdentityError::InvalidEncoding);
        }
        let mut cursor = MAGIC.len();
        let role = match *input
            .get(cursor)
            .ok_or(CredentialIdentityError::InvalidEncoding)?
        {
            1 => DeviceRole::Browser,
            2 => DeviceRole::OwnerDevice,
            _ => return Err(CredentialIdentityError::InvalidEncoding),
        };
        cursor += 1;
        let principal_id = take(input, &mut cursor)?;
        let device_key_id = take(input, &mut cursor)?;
        let epoch_bytes: [u8; 8] = input
            .get(cursor..cursor + 8)
            .ok_or(CredentialIdentityError::InvalidEncoding)?
            .try_into()
            .map_err(|_| CredentialIdentityError::InvalidEncoding)?;
        cursor += 8;
        let target_agent_did = take(input, &mut cursor)?;
        if cursor != input.len() {
            return Err(CredentialIdentityError::InvalidEncoding);
        }
        Ok(Self {
            role,
            principal_id,
            device_key_id,
            key_epoch: u64::from_be_bytes(epoch_bytes),
            target_agent_did,
        })
    }

    pub fn validate_direct_pair(
        creator: &Self,
        recipient: &Self,
    ) -> Result<(), CredentialIdentityError> {
        if creator.role != DeviceRole::Browser || recipient.role != DeviceRole::OwnerDevice {
            return Err(CredentialIdentityError::RoleMismatch);
        }
        if creator.target_agent_did != recipient.target_agent_did {
            return Err(CredentialIdentityError::AgentMismatch);
        }
        creator.encode()?;
        recipient.encode()?;
        Ok(())
    }
}

fn put(
    output: &mut Vec<u8>,
    name: &'static str,
    value: &[u8],
) -> Result<(), CredentialIdentityError> {
    if value.is_empty() {
        return Err(CredentialIdentityError::Empty(name));
    }
    if value.len() > MAX_FIELD {
        return Err(CredentialIdentityError::TooLarge(name));
    }
    output.extend_from_slice(&(value.len() as u16).to_be_bytes());
    output.extend_from_slice(value);
    Ok(())
}

fn take(input: &[u8], cursor: &mut usize) -> Result<Vec<u8>, CredentialIdentityError> {
    let len_bytes: [u8; 2] = input
        .get(*cursor..*cursor + 2)
        .ok_or(CredentialIdentityError::InvalidEncoding)?
        .try_into()
        .map_err(|_| CredentialIdentityError::InvalidEncoding)?;
    *cursor += 2;
    let len = u16::from_be_bytes(len_bytes) as usize;
    if len == 0 || len > MAX_FIELD {
        return Err(CredentialIdentityError::InvalidEncoding);
    }
    let value = input
        .get(*cursor..*cursor + len)
        .ok_or(CredentialIdentityError::InvalidEncoding)?
        .to_vec();
    *cursor += len;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(role: DeviceRole, agent: &[u8]) -> DeviceCredentialIdentity {
        DeviceCredentialIdentity {
            role,
            principal_id: b"opaque-principal".to_vec(),
            device_key_id: b"device-key".to_vec(),
            key_epoch: 4,
            target_agent_did: agent.to_vec(),
        }
    }

    #[test]
    fn encoding_round_trips_without_json_ambiguity() {
        let expected = identity(DeviceRole::Browser, b"did:voko:agent-1");
        assert_eq!(
            DeviceCredentialIdentity::decode(&expected.encode().unwrap()).unwrap(),
            expected
        );
    }

    #[test]
    fn cross_agent_pair_is_rejected() {
        assert_eq!(
            DeviceCredentialIdentity::validate_direct_pair(
                &identity(DeviceRole::Browser, b"did:voko:agent-a"),
                &identity(DeviceRole::OwnerDevice, b"did:voko:agent-b"),
            ),
            Err(CredentialIdentityError::AgentMismatch)
        );
    }
}
