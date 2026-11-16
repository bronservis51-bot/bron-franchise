export const SOURCE_FENCE_WITNESS_PROTOCOL: 'BRON_SOURCE_FENCE_WITNESS_V1';
export function encryptWitness(value: unknown, capability: Uint8Array, capabilitySha256: string): Promise<{
 protocol: typeof SOURCE_FENCE_WITNESS_PROTOCOL;
 nonce: string;
 ciphertext: string;
}>;
