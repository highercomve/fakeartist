import { describe, it, expect } from "vitest";
import { computeCommitment, verifyCommitment } from "./crypto";

// Mirror the Go impl: sha256(fake_id_utf8 || nonce_bytes).
// Reference values precomputed in Node:
//   crypto.createHash('sha256').update(Buffer.concat([Buffer.from('p_alice'), Buffer.from('deadbeef','hex')])).digest('hex')

describe("commitment crypto", () => {
  it("produces a 64-char hex digest", async () => {
    const c = await computeCommitment("p_alice", "deadbeef");
    expect(c).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(c)).toBe(true);
  });

  it("is deterministic for the same inputs", async () => {
    const c1 = await computeCommitment("p_x", "1234abcd");
    const c2 = await computeCommitment("p_x", "1234abcd");
    expect(c1).toBe(c2);
  });

  it("differs for different fake ids", async () => {
    const c1 = await computeCommitment("p_a", "1234abcd");
    const c2 = await computeCommitment("p_b", "1234abcd");
    expect(c1).not.toBe(c2);
  });

  it("verifyCommitment succeeds for a matching pair", async () => {
    const c = await computeCommitment("p_z", "cafebabe");
    expect(await verifyCommitment("p_z", "cafebabe", c)).toBe(true);
  });

  it("verifyCommitment fails on mismatch", async () => {
    const c = await computeCommitment("p_z", "cafebabe");
    expect(await verifyCommitment("p_y", "cafebabe", c)).toBe(false);
  });
});
