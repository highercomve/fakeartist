// HTTP drawer + commitment-verifier helper used by the host engine to
// reach POST /api/rooms/:id/roles and GET /api/rooms/:id/reveal/:round.
// Kept separate from engine.ts so the engine has no fetch coupling and
// remains trivial to unit-test.

import type { DrawResponse, RevealResponse, RoleDrawer } from "./engine";
import { verifyCommitment } from "./crypto";

export interface HttpDrawerOptions {
  // The host's own player id; required so the server knows who to
  // attribute the draw to.
  playerId: string;
  // Override the base URL in tests. Defaults to same-origin.
  baseUrl?: string;
  // Override fetch in tests.
  fetch?: typeof fetch;
}

export class HttpRoleDrawer implements RoleDrawer {
  private opts: Required<HttpDrawerOptions>;
  constructor(opts: HttpDrawerOptions) {
    this.opts = {
      baseUrl: "",
      fetch: globalThis.fetch.bind(globalThis),
      ...opts,
    };
  }

  async draw(
    roomId: string,
    roundIndex: number,
    players: string[],
    pool: { id: string; word: string; author_id: string }[],
  ): Promise<DrawResponse> {
    const res = await this.opts.fetch(`${this.opts.baseUrl}/api/rooms/${roomId}/roles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        player_id: this.opts.playerId,
        round_index: roundIndex,
        connected_players: players,
        pool,
      }),
    });
    if (!res.ok) throw new Error(`roles ${res.status}: ${await res.text()}`);
    return (await res.json()) as DrawResponse;
  }

  async reveal(roomId: string, roundIndex: number): Promise<RevealResponse> {
    const res = await this.opts.fetch(`${this.opts.baseUrl}/api/rooms/${roomId}/reveal/${roundIndex}`);
    if (!res.ok) throw new Error(`reveal ${res.status}: ${await res.text()}`);
    return (await res.json()) as RevealResponse;
  }
}

// verifyReveal pulls the reveal and checks the commitment match. Used
// by clients (host + guests) after ROUND_SUMMARY to catch a lying host.
export async function verifyReveal(
  drawer: RoleDrawer,
  roomId: string,
  roundIndex: number,
  expectedCommitment: string,
): Promise<{ ok: boolean; reveal: RevealResponse }> {
  const reveal = await drawer.reveal(roomId, roundIndex);
  const ok = await verifyCommitment(reveal.fake_id, reveal.nonce, expectedCommitment);
  return { ok, reveal };
}
