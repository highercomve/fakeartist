import { describe, it, expect } from "vitest";
import { elect } from "./election";

describe("elect", () => {
  it("returns null when no candidates connected", () => {
    expect(
      elect({ selfId: "p1", selfVersion: 0, selfLastStrokeIndex: 0, connected: [] }),
    ).toBeNull();
  });

  it("clean winner: highest version wins", () => {
    const winner = elect({
      selfId: "p_a",
      selfVersion: 5,
      selfLastStrokeIndex: 2,
      connected: ["p_a", "p_b", "p_c"],
      peers: {
        p_b: { version: 9, lastStrokeIndex: 1 },
        p_c: { version: 3, lastStrokeIndex: 8 },
      },
    });
    expect(winner).toBe("p_b");
  });

  it("version tie -> stroke_index breaks", () => {
    const winner = elect({
      selfId: "p_a",
      selfVersion: 5,
      selfLastStrokeIndex: 2,
      connected: ["p_a", "p_b"],
      peers: {
        p_b: { version: 5, lastStrokeIndex: 7 },
      },
    });
    expect(winner).toBe("p_b");
  });

  it("full tuple tie -> lowest player_id wins", () => {
    const winner = elect({
      selfId: "p_z",
      selfVersion: 5,
      selfLastStrokeIndex: 7,
      connected: ["p_z", "p_a", "p_m"],
      peers: {
        p_a: { version: 5, lastStrokeIndex: 7 },
        p_m: { version: 5, lastStrokeIndex: 7 },
      },
    });
    expect(winner).toBe("p_a");
  });

  it("self wins when no peer data and self has highest", () => {
    const winner = elect({
      selfId: "p_self",
      selfVersion: 10,
      selfLastStrokeIndex: 4,
      connected: ["p_self", "p_other"],
      // peers map absent — others assumed at (0, 0).
    });
    expect(winner).toBe("p_self");
  });

  it("solo connected peer wins by default", () => {
    const winner = elect({
      selfId: "only",
      selfVersion: 0,
      selfLastStrokeIndex: 0,
      connected: ["only"],
    });
    expect(winner).toBe("only");
  });
});
