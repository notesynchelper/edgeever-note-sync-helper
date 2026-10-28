/**
 * Change detection only needs a stable fingerprint, not a cryptographic hash.
 * `crypto.subtle` is used when the page runs in a secure context (the normal
 * case, including localhost); otherwise a 64-bit FNV-1a fallback keeps sync
 * working on plain-HTTP self-hosted instances.
 */
export async function hashText(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const bytes = new TextEncoder().encode(value);
      const digest = await subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    } catch {
      // fall through to the non-crypto hash
    }
  }
  return fnv1a64(value);
}

const FNV_OFFSET_LOW = 0x84222325;
const FNV_OFFSET_HIGH = 0xcbf29ce4;
const FNV_PRIME_LOW = 0x000001b3;
const FNV_PRIME_HIGH = 0x00000100;

/** High 32 bits of an unsigned 32x32-bit product, exact via 16-bit limbs. */
function multiplyHigh32(left: number, right: number): number {
  const leftLow = left & 0xffff;
  const leftHigh = left >>> 16;
  const rightLow = right & 0xffff;
  const rightHigh = right >>> 16;
  const low = leftLow * rightLow;
  const middleLeft = leftLow * rightHigh;
  const middleRight = leftHigh * rightLow;
  const middle = (low >>> 16) + (middleLeft & 0xffff) + (middleRight & 0xffff);
  return (leftHigh * rightHigh + (middleLeft >>> 16) + (middleRight >>> 16) + (middle >>> 16)) >>> 0;
}

export function fnv1a64(value: string): string {
  let low = FNV_OFFSET_LOW;
  let high = FNV_OFFSET_HIGH;
  for (const byte of new TextEncoder().encode(value)) {
    low = (low ^ byte) >>> 0;
    // hash *= prime, modulo 2^64, on two 32-bit halves.
    const carry = multiplyHigh32(low, FNV_PRIME_LOW);
    high = (Math.imul(high, FNV_PRIME_LOW) + Math.imul(low, FNV_PRIME_HIGH) + carry) >>> 0;
    low = Math.imul(low, FNV_PRIME_LOW) >>> 0;
  }
  return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0");
}
