export const PRIVATE_SNAPSHOT_PROTOCOL: 'BRON_PRIVATE_SNAPSHOT_V1';
export function encryptSnapshot(value: unknown, capability: Uint8Array, capabilitySha256: string): Promise<{
  protocol: typeof PRIVATE_SNAPSHOT_PROTOCOL;
  nonce: string;
  ciphertext: string;
}>;
