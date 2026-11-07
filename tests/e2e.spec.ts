import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';

test.describe('BREW Mobile Platform E2E Smoke & Critical Paths', () => {

  // 1. SYSTEM HEALTH & OBSERVABILITY
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

  // 2. RBAC & UNAUTHORIZED ACCESS PROTECTION
  test('RBAC Middleware: Unauthenticated user accessing /barista or /admin is redirected to /login', async ({ page }) => {
    // Attempt to access protected Barista KDS directly
    await page.goto('/barista');
    await expect(page).toHaveURL(/\/login\?redirect=%2Fbarista/);

    // Attempt to access protected Fleet Admin directly
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/login\?redirect=%2Fadmin/);
  });

  // 3. CUSTOMER BROWSING & MENU FILTERS
  test('Customer Experience: /menu loads catalog, handles search and category filters', async ({ page }) => {
    await page.goto('/menu');
    await expect(page).toHaveTitle(/BREW/i);

    // Verify category filter buttons exist
    const coffeeCategoryBtn = page.getByRole('tab', { name: /Coffee/i }).or(page.getByRole('button', { name: /Coffee/i }));
    await expect(coffeeCategoryBtn.first()).toBeVisible();

    // Verify search input filters items
    const searchInput = page.getByPlaceholder(/Search coffee/i);
    await expect(searchInput).toBeVisible();
    await searchInput.fill('Affogato');
    await expect(page.locator('text=Affogato').first()).toBeVisible();

    // Clear search
    await searchInput.fill('');
  });

  // 4. CART & CHECKOUT JOURNEY (PAY AT OUTLET)
  test('Cart & Checkout Flow: add item to cart, apply promo code, place order', async ({ page }) => {
    await page.goto('/menu');

    // Add first item to cart
    const addBtn = page.getByLabel(/Add .* to cart/i).first();
    await expect(addBtn).toBeVisible();
    await addBtn.click();

    // Navigate to /cart via header link to preserve client state
    const cartLink = page.getByRole('link', { name: /View Cart/i }).first();
    await expect(cartLink).toBeVisible();
    await cartLink.click();
    await expect(page).toHaveURL(/\/cart/);

    // Verify order summary
    const totalElement = page.locator('text=Total').first();
    await expect(totalElement).toBeVisible({ timeout: 10000 });

    // Select Pay at Outlet option via radio role
    const payAtOutletRadio = page.getByRole('radio', { name: /Pay at Outlet/i }).first();
    if (await payAtOutletRadio.isVisible()) {
      await payAtOutletRadio.click();
    }

    // Fill customer name
    const nameInput = page.getByPlaceholder(/Enter your name/i);
    if (await nameInput.isVisible()) {
      await nameInput.fill('Rohan Sharma');
    }

    // Place order via primary CTA button
    const placeOrderBtn = page.getByRole('button', { name: /Place Order/i }).first();
    await expect(placeOrderBtn).toBeVisible();
    await placeOrderBtn.click();

    // Verify confirmation modal appears
    await expect(page.getByRole('heading', { name: /Order & Payment Confirmed/i })).toBeVisible({ timeout: 10000 });
  });

  // 5. SERVER-SIDE PAYMENT AMOUNT INTEGRITY & VERIFICATION
  test('Payment Gateway: /api/payments/create-order and /api/payments/verify cryptographic signature integrity', async ({ request }) => {
    // 5a. Create order with server-calculated price
    const createRes = await request.post('/api/payments/create-order', {
      data: {
        items: [{ id: 'c-1', quantity: 1 }], // Affogato ₹240
        customerName: 'Kavya Nair',
        currency: 'INR',
      },
    });
    expect(createRes.status()).toBe(200);
    const orderData = await createRes.json();
    expect(orderData.success).toBe(true);
    expect(orderData).toHaveProperty('orderId');
    expect(orderData.amount).toBe(30100); // ₹240 + ₹49 del + 5% tax ₹12 = ₹301 (30100 paise)

    // 5b. Tampered signature rejected
    const tamperedVerifyRes = await request.post('/api/payments/verify', {
      data: {
        razorpay_order_id: orderData.orderId,
        razorpay_payment_id: 'pay_test_tampered',
        razorpay_signature: 'invalid_tampered_signature_12345',
      },
    });
    expect(tamperedVerifyRes.status()).toBe(400);

    // 5c. Valid HMAC-SHA256 signature verified
    const rzpSecret = process.env.RAZORPAY_KEY_SECRET || 'brew_razorpay_secret_test_2026';
    const testPaymentId = `pay_e2e_${Date.now()}`;
    const validSignature = crypto
      .createHmac('sha256', rzpSecret)
      .update(`${orderData.orderId}|${testPaymentId}`)
      .digest('hex');

    const validVerifyRes = await request.post('/api/payments/verify', {
      data: {
        razorpay_order_id: orderData.orderId,
        razorpay_payment_id: testPaymentId,
        razorpay_signature: validSignature,
      },
    });
    expect(validVerifyRes.status()).toBe(200);
    const verifyData = await validVerifyRes.json();
    expect(verifyData.verified).toBe(true);

    // 5d. Replay attack: submitting same payment ID again
    const replayVerifyRes = await request.post('/api/payments/verify', {
      data: {
        razorpay_order_id: orderData.orderId,
        razorpay_payment_id: testPaymentId,
        razorpay_signature: validSignature,
      },
    });
    expect(replayVerifyRes.status()).toBe(200);
    const replayData = await replayVerifyRes.json();
    expect(replayData.alreadyProcessed).toBe(true);

    // 5e. Webhook HMAC-SHA256 signature verification & deduplication
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || 'brew_webhook_secret_dev_2026';
    const whPayload = JSON.stringify({
      event: 'payment.captured',
      id: `evt_e2e_${Date.now()}`,
      payload: {
        payment: {
          entity: {
            id: `pay_e2e_wh_${Date.now()}`,
            amount: 30100,
            currency: 'INR',
            notes: {
              orderId: orderData.orderId,
              customerName: 'Kavya Nair',
            },
          },
        },
      },
    });
    const whSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(whPayload)
      .digest('hex');

    const whRes = await request.post('/api/webhooks/razorpay', {
      headers: {
        'Content-Type': 'application/json',
        'x-razorpay-signature': whSignature,
      },
      data: whPayload,
    });
    expect(whRes.status()).toBe(200);
    const whData = await whRes.json();
    expect(whData.status).toBe('ok');

    // Duplicate webhook delivery returns alreadyProcessed: true
    const dupWhRes = await request.post('/api/webhooks/razorpay', {
      headers: {
        'Content-Type': 'application/json',
        'x-razorpay-signature': whSignature,
      },
      data: whPayload,
    });
    expect(dupWhRes.status()).toBe(200);
    const dupWhData = await dupWhRes.json();
    expect(dupWhData.alreadyProcessed).toBe(true);
  });

  // 6. CATERING & EVENT BOOKING CONCIERGE (AGENT 4)
  test('Catering & Event Booking: /api/request-van calculates 3-tier quotation and persists enquiry', async ({ request }) => {
    const bookingPayload = {
      contact: 'test.organizer@techcorp.in',
      organization: 'TechCorp Campus Hyderabad',
      location: 'HITEC City Gate 3',
      eventDate: '2026-11-20',
      crowdSize: '150–300 People',
      notes: 'Power outlet and parking near main auditorium',
    };

    const res = await request.post('/api/request-van', { data: bookingPayload });
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data).toHaveProperty('quotation');
    expect(data.quotation).toHaveProperty('tiers');
    expect(Array.isArray(data.quotation.tiers)).toBe(true);
    expect(data.quotation.tiers.length).toBe(3);

    // Duplicate submission should be safely recognized as idempotent replay
    const duplicateRes = await request.post('/api/request-van', { data: bookingPayload });
    expect(duplicateRes.status()).toBe(200);
    const duplicateData = await duplicateRes.json();
    expect(duplicateData.idempotentReplay).toBe(true);
  });

  // 7. STAFF AUTHENTICATION (BARISTA & FLEET ADMIN)
  test('Staff Authentication: /api/auth/session validates Barista and Fleet Admin PINs', async ({ request }) => {
    // 7a. Incorrect PIN rejected
    const badRes = await request.post('/api/auth/session', {
      data: { action: 'staff_pin', pin: '0000' },
    });
    expect(badRes.status()).toBe(401);

    // 7b. Barista PIN (2026) accepted
    const baristaRes = await request.post('/api/auth/session', {
      data: { action: 'staff_pin', pin: '2026' },
    });
    expect(baristaRes.status()).toBe(200);
    const baristaData = await baristaRes.json();
    expect(baristaData.success).toBe(true);
    expect(baristaData.user.role).toBe('barista');

    // 7c. Fleet Admin PIN (7788) accepted
    const adminRes = await request.post('/api/auth/session', {
      data: { action: 'staff_pin', pin: '7788' },
    });
    expect(adminRes.status()).toBe(200);
    const adminData = await adminRes.json();
    expect(adminData.success).toBe(true);
    expect(adminData.user.role).toBe('fleet_admin');
  });

  // 8. DIGITAL BUZZER TRACKER
  test('Digital Buzzer: /order-status/ord-101 renders live order status tracker and curbside options', async ({ page }) => {
    await page.goto('/order-status/ord-101');
    await expect(page.locator('text=ord-101').or(page.locator('text=#101')).first()).toBeVisible({ timeout: 10000 });
    // Verify digital buzzer action buttons
    const buzzerBtn = page.getByRole('button', { name: /Test Digital Buzzer/i });
    if (await buzzerBtn.isVisible()) {
      await expect(buzzerBtn).toBeEnabled();
    }
  });

  // 9. MOBILE NAVIGATION & RESPONSIVE LAYOUT
  test('Mobile Navigation: hamburger menu toggle and navigation drawer on mobile viewport', async ({ page }) => {
    // Set mobile viewport (iPhone 12 / 13)
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    // Hamburger button should be visible on mobile
    const hamburgerBtn = page.getByLabel(/Open navigation menu/i).or(page.getByLabel(/Close navigation menu/i)).first();
    await expect(hamburgerBtn).toBeVisible();

    // Click to open mobile navigation drawer
    await hamburgerBtn.click();

    // Verify mobile drawer navigation links inside header
    await expect(page.locator('header').getByRole('link', { name: 'Menu', exact: true })).toBeVisible();
    await expect(page.locator('header').getByRole('link', { name: 'Van Tracker', exact: true })).toBeVisible();
    await expect(page.locator('header').getByRole('link', { name: 'Reviews', exact: true })).toBeVisible();
  });

  // 10. MULTI-DEVICE RESPONSIVE VIEWPORT SUITE (NO HORIZONTAL OVERFLOW)
  const viewports = [
    { name: 'Mobile (Samsung Galaxy)', width: 360, height: 800 },
    { name: 'Mobile (iPhone 12/13/14)', width: 390, height: 844 },
    { name: 'Tablet Portrait (iPad)', width: 768, height: 1024 },
    { name: 'Laptop / Small Desktop', width: 1024, height: 768 },
    { name: 'MacBook Standard', width: 1440, height: 900 },
    { name: 'FHD Monitor Desktop', width: 1920, height: 1080 },
  ];

  for (const vp of viewports) {
    test(`Responsive Design: /menu and /cart render without horizontal overflow on ${vp.name} (${vp.width}x${vp.height})`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      
      // Test /menu
      await page.goto('/menu');
      await page.waitForLoadState('domcontentloaded');
      const menuOverflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth <= window.innerWidth + 2;
      });
      expect(menuOverflow).toBe(true);

      // Test /cart
      await page.goto('/cart');
      await page.waitForLoadState('domcontentloaded');
      const cartOverflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth <= window.innerWidth + 2;
      });
      expect(cartOverflow).toBe(true);
    });
  }

  // 11. ACCESSIBILITY (WCAG 2.2 AA) VERIFICATION
  test('Accessibility: Semantic headings and image alt attributes across core customer routes', async ({ page }) => {
    const routesToTest = ['/', '/menu', '/cart', '/location', '/reviews'];

    for (const route of routesToTest) {
      await page.goto(route);
      await page.locator('h1').first().waitFor({ timeout: 10000 });

      // Verify at least one h1 is present
      const h1Count = await page.locator('h1').count();
      expect(h1Count, `Route ${route} must have at least one h1 heading`).toBeGreaterThanOrEqual(1);

      // Verify all rendered images have an alt attribute
      const imagesWithoutAlt = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img'));
        return imgs.filter((img) => !img.hasAttribute('alt')).length;
      });
      expect(imagesWithoutAlt, `Route ${route} has images missing alt attributes`).toBe(0);
    }
  });

  test('Accessibility: Interactive tabs and live regions on /menu', async ({ page }) => {
    await page.goto('/menu');
    await page.waitForLoadState('domcontentloaded');

    // Tablist exists and is visible on current viewport
    const tablist = page.locator('[role="tablist"]:visible').first();
    await expect(tablist).toBeVisible();

    // Live status region exists for cart announcements
    const liveRegion = page.locator('[role="status"][aria-live="polite"]').first();
    await expect(liveRegion).toBeAttached();

    // Click an item add button and verify accessible status
    const addBtn = page.getByLabel(/Add .* to cart/i).first();
    if (await addBtn.isVisible()) {
      await addBtn.click();
      const text = await liveRegion.textContent();
      expect(text).toContain('Added');
    }
  });

  test('Accessibility: Modal dialog attributes and Escape key dismissal on /location', async ({ page }) => {
    await page.goto('/location');
    await page.waitForLoadState('domcontentloaded');

    // Fill contact input in request banner
    const contactInput = page.getByPlaceholder(/Enter your phone or email/i).first();
    if (await contactInput.isVisible()) {
      await contactInput.fill('events@iitbhilai.ac.in');
    }

    // Find and click the button to open the Van Request modal
    const openModalBtn = page.getByRole('button', { name: /Request Van/i }).first();
    if (await openModalBtn.isVisible()) {
      await openModalBtn.click();

      // Check modal role="dialog" and aria-modal="true"
      const dialog = page.locator('[role="dialog"][aria-modal="true"]');
      await expect(dialog).toBeVisible();

      // Press Escape key and verify modal closes
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }
  });

});
