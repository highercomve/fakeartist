import { test, expect } from '@playwright/test';

// Joining a code that doesn't map to a room should show "Room not found"
// from P2pGameProvider.handleJoin via the lookupRoom(code) path.
test('joining a nonexistent room shows an error', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Join Game' }).click();

  await page.locator('input.text-uppercase').fill('ZZZZ');
  await page.locator('form input.form-control:not(.text-uppercase)').first().fill('Guest');
  await page.getByRole('button', { name: 'Join', exact: true }).click();

  await expect(page.locator('.alert.alert-danger')).toContainText('Room not found');
});
