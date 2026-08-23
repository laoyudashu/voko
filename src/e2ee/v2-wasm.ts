export interface E2eeV2PublicBundle {
  version: 'voko.e2ee/2';
  keyId: string;
  hpkePublicKey: string;
  signingPublicKey: string;
}

export interface E2eeV2Envelope {
  version: 'voko.e2ee/2';
  suite: 'X25519-HKDF-SHA256-CHACHA20POLY1305';
  messageId: string;
  conversationId: string;
  channelId: string;
  agentDid: string;
  senderDeviceId: string;
  senderKeyId: string;
  recipientDeviceId: string;
  recipientKeyId: string;
  createdAtMs: number;
  contentKind: 'text'|'attachment_manifest';
  enc: string;
  ciphertext: string;
  signature: string;
}

type WasmEndpoint = {
  free(): void;
  private_bundle_json(): string;
  public_bundle_json(): string;
  seal(recipientPublicJson: string, headerJson: string, plaintext: Uint8Array): string;
  open(senderPublicJson: string, envelopeJson: string): Uint8Array;
};

type WasmConstructor = {
  generate(): WasmEndpoint;
  fromPrivateBundle(bundleJson: string): WasmEndpoint;
};

const binding = require('./wasm/voko_e2ee_wasm') as { WasmMessageV2: WasmConstructor };

function parseJsonObject<T>(value: string, code: string): T {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(code); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(code);
  return parsed as T;
}

export class E2eeV2Crypto {
  private constructor(private readonly endpoint: WasmEndpoint) {}

  static generate(): E2eeV2Crypto {
    return new E2eeV2Crypto(binding.WasmMessageV2.generate());
  }

  static restore(privateBundleJson: string): E2eeV2Crypto {
    return new E2eeV2Crypto(binding.WasmMessageV2.fromPrivateBundle(privateBundleJson));
  }

  privateBundleJson(): string { return this.endpoint.private_bundle_json(); }

  publicBundle(): E2eeV2PublicBundle {
    return parseJsonObject<E2eeV2PublicBundle>(this.endpoint.public_bundle_json(), 'E2EE_V2_PUBLIC_BUNDLE_INVALID');
  }

  seal(recipient: E2eeV2PublicBundle, header: Omit<E2eeV2Envelope,'enc'|'ciphertext'|'signature'>,
    plaintext: Uint8Array): E2eeV2Envelope {
    return parseJsonObject<E2eeV2Envelope>(
      this.endpoint.seal(JSON.stringify(recipient),JSON.stringify(header),plaintext),
      'E2EE_V2_ENVELOPE_INVALID',
    );
  }

  open(sender: E2eeV2PublicBundle, envelope: E2eeV2Envelope): Uint8Array {
    return this.endpoint.open(JSON.stringify(sender),JSON.stringify(envelope));
  }

  free(): void { this.endpoint.free(); }
}

module.exports = { E2eeV2Crypto };
