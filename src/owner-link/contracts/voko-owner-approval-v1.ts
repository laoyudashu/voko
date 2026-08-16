export type OwnerAction = { type: 'message'; text: string };
export type OwnerApprovalEnforcement = 'required_before_execute';
export type OwnerApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked' | 'consumed';
export interface OwnerCommandApproval { approvalId: string; actionDigest: string; expiresAt: string; enforcement: OwnerApprovalEnforcement; }
export interface OwnerApprovedExecutePayload { action: OwnerAction; approval: OwnerCommandApproval; }
