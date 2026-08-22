export type E2eeSessionMode = 'plaintext' | 'e2ee_available' | 'e2ee_active' | 'e2ee_required';
export type E2eeCapabilityEvidence = 'supported' | 'unsupported' | 'unknown' | 'handshake_failed' | 'identity_changed';

export interface E2eeModeRecord {
  mode: E2eeSessionMode;
  capability: E2eeCapabilityEvidence;
  everActive: boolean;
}

export function nextE2eeMode(current: E2eeModeRecord, event:
  | { type: 'capability'; evidence: E2eeCapabilityEvidence }
  | { type: 'activate' }
  | { type: 'require' }
  | { type: 'new_plaintext_conversation' }): E2eeModeRecord {
  if (event.type === 'new_plaintext_conversation') {
    return { mode: 'plaintext', capability: 'unknown', everActive: false };
  }
  if (event.type === 'activate') return { mode: 'e2ee_active', capability: 'supported', everActive: true };
  if (event.type === 'require') return { mode: 'e2ee_required', capability: current.capability, everActive: current.everActive };

  if (event.evidence === 'supported') {
    if (current.mode === 'e2ee_required' || current.mode === 'e2ee_active') return { ...current, capability: 'supported' };
    return { mode: 'e2ee_available', capability: 'supported', everActive: current.everActive };
  }
  if (event.evidence === 'unsupported') {
    if (current.everActive || current.mode === 'e2ee_active' || current.mode === 'e2ee_required') {
      return { ...current, capability: 'identity_changed' };
    }
    return { mode: 'plaintext', capability: 'unsupported', everActive: false };
  }
  // Unknown capability, handshake failure and identity change never prove that
  // plaintext is safe. Once encrypted, the original conversation cannot fall
  // back; before activation the current mode is retained for explicit retry.
  return { ...current, capability: event.evidence };
}

export function maySendPlaintext(record: E2eeModeRecord): boolean {
  return record.mode === 'plaintext' && !record.everActive
    && (record.capability === 'unsupported' || record.capability === 'unknown');
}

module.exports = { nextE2eeMode, maySendPlaintext };
