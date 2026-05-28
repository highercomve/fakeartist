import { test, expect, type Page } from '@playwright/test';

// Two-browser-context test: host creates a room, guest joins by code,
// both contexts converge on a lobby where both players are listed.
// Exercises the full signaling + RTC/relay stack inside the container.
test('host creates room and guest joins; both see each other in the lobby', async ({ browser }) => {
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

    // Wait for the host lobby. Room code lives in the badge.
    const roomBadge = host.locator('h4.text-primary span.badge');
    await expect(roomBadge).toBeVisible({ timeout: 10_000 });
    const code = (await roomBadge.textContent())?.trim() ?? '';
    expect(code).toMatch(/^[A-Z0-9]+$/);

    // -- guest joins via the same code --
    await guest.goto('/');
    await guest.getByRole('button', { name: 'Join Game' }).click();
    await guest.locator('input.text-uppercase').fill(code);
    await guest.locator('form input.form-control:not(.text-uppercase)').first().fill('Bob');
    await guest.getByRole('button', { name: 'Join', exact: true }).click();

    // Both contexts should converge on a lobby that lists both players.
    const hostPlayers = host.locator('ul.list-group li.list-group-item');
    const guestPlayers = guest.locator('ul.list-group li.list-group-item');

    await expect(hostPlayers).toHaveCount(2, { timeout: 15_000 });
    await expect(guestPlayers).toHaveCount(2, { timeout: 15_000 });

    await expect(host.locator('ul.list-group')).toContainText('Alice');
    await expect(host.locator('ul.list-group')).toContainText('Bob');
    await expect(guest.locator('ul.list-group')).toContainText('Alice');
    await expect(guest.locator('ul.list-group')).toContainText('Bob');

    // Host sees the Start Game button (admin); with 2 players and
    // min_players=3 it should still be disabled and say "need 1 more".
    const startBtn = host.getByRole('button', { name: /Start Game/ });
    await expect(startBtn).toBeDisabled();
    await expect(startBtn).toHaveText(/need 1 more/);

    // Guest sees the "Waiting for host…" notice instead of Start Game.
    await expect(guest.locator('.alert.alert-success')).toContainText('Waiting for host');
  } finally {
    await hostCtx.close();
    await guestCtx.close();
  }
});
