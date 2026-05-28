import { test, expect } from '@playwright/test';

// Visiting /room/<CODE> directly should land the user on the Join form
// with the room code prefilled (parseRoomCodeFromPath in P2pGameProvider).
test('shared /room/<CODE> link prefills the Join form', async ({ page }) => {
  await page.goto('/room/ABCD');

  // The Join form (not the menu) should be shown.
  await expect(page.getByRole('heading', { name: 'Join Room' })).toBeVisible();

  // Code input has the path-derived value (uppercased).
  const codeInput = page.locator('input.text-uppercase');
  await expect(codeInput).toHaveValue('ABCD');
});
