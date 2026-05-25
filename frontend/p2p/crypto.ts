// Commitment helpers. The server publishes
//   commitment = sha256(fake_id_utf8 || nonce_bytes)
// at draw time, and the nonce at reveal time. Clients verify both match.
//
// We use the global `crypto.subtle` API. Node 16+ and all evergreen
// browsers expose it.

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

// computeCommitment is the inverse of the server function in draw.go.
export async function computeCommitment(fakeId: string, nonceHex: string): Promise<string> {
  const idBytes = utf8(fakeId);
  const nonceBytes = hexToBytes(nonceHex);
  const buf = new Uint8Array(idBytes.length + nonceBytes.length);
  buf.set(idBytes, 0);
  buf.set(nonceBytes, idBytes.length);
  const subtle = (globalThis.crypto as Crypto).subtle;
  const digest = await subtle.digest("SHA-256", buf);
  return bytesToHex(new Uint8Array(digest));
}

// verifyCommitment returns true iff sha256(fake_id || nonce) matches the
// committed digest. Callers should treat false as a host cheat signal.
export async function verifyCommitment(
  fakeId: string,
  nonceHex: string,
  expectedCommitmentHex: string,
): Promise<boolean> {
  const got = await computeCommitment(fakeId, nonceHex);
  return constantTimeEqual(got, expectedCommitmentHex);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
