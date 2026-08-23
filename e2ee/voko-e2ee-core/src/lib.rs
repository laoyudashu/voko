//! Stateless per-message E2EE primitives shared by VOKO Lite and Chatroom.

mod message_v2;
pub use message_v2::{
    DevicePrivateBundleV2, DevicePublicBundleV2, MessageContentKindV2, MessageEnvelopeV2,
    MessageHeaderV2, MessageV2Error, E2EE_V2_PROTOCOL, E2EE_V2_SUITE,
};
