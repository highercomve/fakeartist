import { test, expect } from '@playwright/test';

// Verifies the rooms.Manager GC sweep actually evicts an abandoned
// room end-to-end: host creates a room, no further activity bumps
// UpdatedAt, the sweeper reaps it, and a fresh guest attempting to
// join that code sees the "Room not found" alert (the same UI surface
// covered by invalid-room.spec.ts, but reached via eviction rather
// than a bogus code).
//
// Prerequisite: bring up the container with shrunken GC windows so the
// test runs in a few seconds, e.g.
//   GC_IDLE_TTL=2s GC_FINISHED_GRACE=1s GC_SWEEP_INTERVAL=500ms \
//     docker compose up -d --build
// Then `bunx playwright test gc-reaps-idle-room`. Without the env
// overrides this test will time out (defaults are 10m / 1m / 1m).
test('idle room is GC-evicted and can no longer be joined', async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  try {
    // -- host creates a room --
    await host.goto('/');
    await host.getByRole('button', { name: 'Create Game' }).click();
    await host.locator('form input.form-control:not([type="number"])').first().fill('Alice');
    await host.locator('#minPlayers').fill('3');
    await host.getByRole('button', { name: 'Create & Join' }).click();

    const roomBadge = host.locator('h4.text-primary span.badge');
    await expect(roomBadge).toBeVisible({ timeout: 10_000 });
    const code = (await roomBadge.textContent())?.trim() ?? '';
    expect(code).toMatch(/^[A-Z0-9]+$/);

    // -- wait past IdleTTL + one sweep tick --
    // With GC_IDLE_TTL=2s + GC_SWEEP_INTERVAL=500ms, the room becomes
    // eligible for eviction at ~2s and the next sweep fires by ~2.5s.
    // Pad to 4s for headroom on slower CI. Host's open WS does not
    // bump UpdatedAt (signaling traffic is hub-side; only manager
    // mutations touch UpdatedAt), so the room genuinely goes idle.
    await host.waitForTimeout(4_000);

    // -- guest tries to join the now-evicted code --
    await guest.goto('/');
    await guest.getByRole('button', { name: 'Join Game' }).click();
    await guest.locator('input.text-uppercase').fill(code);
    await guest.locator('form input.form-control:not(.text-uppercase)').first().fill('Bob');
    await guest.getByRole('button', { name: 'Join', exact: true }).click();

    // Same error surface invalid-room.spec.ts asserts against — proof
    // that from the user's POV the room is fully gone, not just
    // unreachable at the WS layer.
    await expect(guest.locator('.alert.alert-danger')).toContainText('Room not found');
  } finally {
    await hostCtx.close();
    await guestCtx.close();
  }
});
