import { test, expect } from '@playwright/test';

// Regression test for the min_players config bug. The host's
// CONFIGURE_GAME used to fire before JOIN_GAME, so the engine
// dropped the config (requireHost failed when host_id was still
// empty). The lobby then showed the default min_players=4.
// With min_players=3 + 1 host present, the button must read
// "need 2 more" — not "need 3 more".
test('min_players config from Create form is applied to the lobby', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Create Game' }).click();

  // The "Your Name" input has no id/for-association — target it as the
  // first non-numeric input inside the Configure form.
  await page.locator('form input.form-control:not([type="number"])').first().fill('TestHost');
  await page.locator('#minPlayers').fill('3');

  await page.getByRole('button', { name: 'Create & Join' }).click();

  const startBtn = page.getByRole('button', { name: /Start Game/ });
  await expect(startBtn).toBeVisible();
  await expect(startBtn).toHaveText(/need 2 more/);
  await expect(startBtn).not.toHaveText(/need 3 more/);
});
