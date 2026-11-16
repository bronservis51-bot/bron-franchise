export const ADMISSION_METADATA_PROTOCOL: 'BRON_ADMISSION_METADATA_V1';
export function encryptMetadata(value: unknown, capability: Uint8Array, capabilitySha256: string): Promise<{
 protocol: typeof ADMISSION_METADATA_PROTOCOL;
 nonce: string;
 ciphertext: string;
}>;
