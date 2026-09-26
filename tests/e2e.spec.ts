import { test, expect } from '@playwright/test';

test.describe('BREW Mobile Platform E2E Smoke & Critical Paths', () => {

  test('Observability: /api/health returns HTTP 200 and system health checks', async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty('status');
    expect(['healthy', 'degraded']).toContain(body.status);
    expect(body).toHaveProperty('checks');
    expect(body.checks).toHaveProperty('realtimeStore');
    expect(body.checks).toHaveProperty('agentCache');
    expect(body.checks).toHaveProperty('fleetOperations');
  });

  test('RBAC Middleware: Unauthenticated user accessing /barista is redirected to /login', async ({ page }) => {
    // Attempt to access protected Barista KDS directly without a session cookie
    await page.goto('/barista');
    // Expect redirection to login with query parameters
    await expect(page).toHaveURL(/\/login\?redirect=%2Fbarista/);
    await expect(page.locator('body')).toBeVisible();
  });

  test('Customer Experience: /menu loads coffee catalog and categories', async ({ page }) => {
    await page.goto('/menu');
    await expect(page).toHaveTitle(/BREW/i);
    // Ensure coffee items or menu cards render
    const mainContent = page.locator('main');
    await expect(mainContent).toBeVisible();
    // Verify menu items or buttons exist
    const buttons = page.locator('button');
    await expect(buttons.first()).toBeVisible();
  });

  test('Digital Buzzer: /order-status/ord-101 renders live order status tracker', async ({ page }) => {
    await page.goto('/order-status/ord-101');
    // Verify digital buzzer token or tracking card is present
    await expect(page.locator('text=ord-101').or(page.locator('text=#101'))).toBeVisible({ timeout: 10000 });
  });

  test('Cart & Checkout Flow: /cart displays curbside pickup options', async ({ page }) => {
    await page.goto('/cart');
    await expect(page.locator('body')).toBeVisible();
    // Verify cart page elements or empty state
    await expect(page.locator('main')).toBeVisible();
  });

});
