const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../src/app');
const { getDb } = require('../src/db/database');
const { signWebhookPayload } = require('../src/services/paymentService');

const TEST_DB_PATH = path.join(__dirname, '..', 'data', `test_hotel_${ process.pid }.db`);

let server;
let baseUrl;

async function reqJson(method, endpoint, body = null, headers = {}) {
  const url = `${baseUrl}${endpoint}`;
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  };
  if (body !== null) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, headers: res.headers };
}

describe('Maison Aurélia Luxury Hotel & Online Reservation Platform — End-to-End Suite', () => {
  before(async () => {
    const app = createApp(TEST_DB_PATH);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    try {
      const db = getDb();
      db.close();
    } catch (_) {}
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(TEST_DB_PATH + suffix)) {
        try {
          fs.unlinkSync(TEST_DB_PATH + suffix);
        } catch (_) {}
      }
    }
  });

  it('1. Serves complete room catalogue with all 10 categories, 16 physical rooms, and staging sample inventory labeling', async () => {
    const { status, data } = await reqJson('GET', '/api/catalogue');
    assert.equal(status, 200);
    assert.equal(data.environmentMode, 'staging');
    assert.ok(data.environmentBanner.includes('STAGING'));
    assert.equal(data.categories.length, 10);
    assert.ok(data.rooms.length >= 16);

    const expectedSlugs = [
      'standard-rooms',
      'deluxe-rooms',
      'superior-rooms',
      'executive-rooms',
      'junior-suites',
      'luxury-suites',
      'presidential-suites',
      'family-rooms',
      'penthouse-suites',
      'accessible-rooms'
    ];
    for (const slug of expectedSlugs) {
      const found = data.categories.find((c) => c.slug === slug);
      assert.ok(found, `Expected category ${slug} to exist`);
    }

    const presRoom = data.rooms.find((r) => r.roomNumber === '701');
    assert.ok(presRoom);
    assert.equal(presRoom.uniqueCode, 'AUR-PRES-701');
    assert.equal(presRoom.isSampleInventory, true);
    assert.ok(presRoom.amenities.length > 0);
    assert.ok(presRoom.checkInPolicy.includes('15:00'));
  });

  it('2. Calculates real-time availability with exact required "Room Available" copy, taxes, extras, and multi-currency conversion', async () => {
    const { status, data } = await reqJson('POST', '/api/availability/search', {
      checkIn: '2026-11-01',
      checkOut: '2026-11-04',
      adults: 2,
      children: 0,
      roomsRequired: 1,
      currency: 'EUR'
    });
    assert.equal(status, 200);
    assert.equal(data.searchParams.nights, 3);
    assert.ok(data.availableRooms.length >= 16);

    const firstRoom = data.availableRooms[0];
    assert.equal(firstRoom.availabilityHeading, 'Room Available');
    assert.equal(
      firstRoom.availabilityMessage,
      'This room is available for your selected dates. You can proceed with your reservation.'
    );
    assert.equal(firstRoom.pricing.displayCurrency, 'EUR');
    assert.ok(firstRoom.pricing.totalAmount > firstRoom.pricing.roomSubtotal);
    assert.ok(firstRoom.pricing.convertedTotalAmount > 0);
  });

  it('3. Enforces temporary checkout inventory holds and automatically releases expired holds', async () => {
    const cat = await reqJson('GET', '/api/catalogue');
    const room101 = cat.data.rooms.find((r) => r.roomNumber === '101');

    // Guest Session A places a short 1-second hold on Room #101
    const holdRes = await reqJson('POST', '/api/holds', {
      roomIds: [room101.id],
      checkIn: '2026-11-05',
      checkOut: '2026-11-08',
      adults: 2,
      children: 0,
      sessionId: 'sess_guest_A',
      customHoldSeconds: 1
    });
    assert.equal(holdRes.status, 201);
    assert.ok(holdRes.data.holdToken.startsWith('HLD-'));

    // Immediately while hold is active, Guest Session B tries to hold the same room -> must fail with 409
    const conflictHold = await reqJson('POST', '/api/holds', {
      roomIds: [room101.id],
      checkIn: '2026-11-06',
      checkOut: '2026-11-07',
      adults: 2,
      children: 0,
      sessionId: 'sess_guest_B'
    });
    assert.equal(conflictHold.status, 409);

    // Wait 1.5 seconds for the 1-second hold to expire
    await new Promise((r) => setTimeout(r, 1500));

    // Now Guest Session B can hold Room #101 because the expired hold automatically released inventory
    const holdAfterExpiry = await reqJson('POST', '/api/holds', {
      roomIds: [room101.id],
      checkIn: '2026-11-05',
      checkOut: '2026-11-08',
      adults: 2,
      children: 0,
      sessionId: 'sess_guest_B'
    });
    assert.equal(holdAfterExpiry.status, 201);

    // Release hold cleanly
    await reqJson('DELETE', `/api/holds/${holdAfterExpiry.data.holdToken}?sessionId=sess_guest_B`);
  });

  it('4. Prevents double bookings under concurrent booking attempts and enforces SQLite database-level triggers', async () => {
    const cat = await reqJson('GET', '/api/catalogue');
    const presRoom = cat.data.rooms.find((r) => r.roomNumber === '701');

    // Tokenise a valid card first
    const tokRes = await reqJson('POST', '/api/payments/tokenise', {
      cardholderName: 'CONCURRENT BUYER',
      cardNumber: '4532015112834242',
      expiryMonth: '12',
      expiryYear: '2029',
      cvv: '991'
    });
    assert.equal(tokRes.status, 201);

    // Fire 5 simultaneous booking requests for Room #701 for overlapping dates (2026-11-10 to 2026-11-14)
    const concurrentAttempts = Array.from({ length: 5 }, (_, idx) =>
      reqJson('POST', '/api/bookings', {
        roomIds: [presRoom.id],
        checkIn: '2026-11-10',
        checkOut: '2026-11-14',
        adults: 2,
        children: 0,
        guestFirstName: `Buyer${idx + 1}`,
        guestLastName: 'Concurrent',
        guestEmail: `buyer${idx + 1}@example.com`,
        guestPhone: '+41 22 000 0000',
        paymentMethod: 'card',
        paymentPlan: 'full',
        paymentToken: tokRes.data.tokenId,
        sessionId: `concurrent_sess_${idx + 1}`
      })
    );

    const results = await Promise.all(concurrentAttempts);
    const successes = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);

    assert.equal(successes.length, 1, 'Exactly ONE concurrent booking request must succeed');
    assert.equal(conflicts.length, 4, 'All other 4 concurrent overlapping requests must be rejected with 409');

    // Verify search now reports exact required "Room Unavailable for Selected Dates" message + alternatives + nearby dates
    const searchAfter = await reqJson('POST', '/api/availability/search', {
      checkIn: '2026-11-11',
      checkOut: '2026-11-13',
      adults: 2,
      children: 0
    });
    const presStatus = searchAfter.data.rooms.find((r) => r.id === presRoom.id);
    assert.equal(presStatus.isAvailable, false);
    assert.equal(presStatus.availabilityHeading, 'Room Unavailable for Selected Dates');
    assert.equal(
      presStatus.availabilityMessage,
      'Sorry, this room has already been booked or is unavailable for part or all of your selected stay. Please choose different dates or explore other available rooms.'
    );
    assert.ok(presStatus.alternativeRooms.length > 0, 'Must suggest alternative available rooms');
    assert.ok(presStatus.nearbyAvailableDates.length > 0, 'Must suggest nearby available dates');

    // Verify database-level BEFORE INSERT trigger directly blocks raw SQL overlapping insert
    const db = getDb();
    assert.throws(() => {
      db.prepare(`
        INSERT INTO reservation_rooms (
          reservation_id, room_id, room_number, room_name, category_name,
          check_in, check_out, nightly_rate, nights, room_total, status
        ) VALUES (?, ?, '701', 'Presidential', 'Presidential Suites', '2026-11-12', '2026-11-15', 3800, 3, 11400, 'active')
      `).run(successes[0].data.reservation.id, presRoom.id);
    }, /DOUBLE_BOOKING_CONFLICT/);
  });

  it('5. Supports same-day turnover (arrival on another guest’s departure date)', async () => {
    const cat = await reqJson('GET', '/api/catalogue');
    const presRoom = cat.data.rooms.find((r) => r.roomNumber === '701');

    // Room #701 is booked 2026-11-10 to 2026-11-14 (departure on 2026-11-14).
    // Check availability starting on 2026-11-14 -> 2026-11-16
    const searchTurnover = await reqJson('POST', '/api/availability/search', {
      checkIn: '2026-11-14',
      checkOut: '2026-11-16',
      adults: 2,
      children: 0
    });
    const presTurnover = searchTurnover.data.rooms.find((r) => r.id === presRoom.id);
    assert.equal(presTurnover.isAvailable, true, 'Room must be available for check-in on prior guest departure date');
  });

  it('6. Rejects declined cards without creating bookings, and processes deposit payments + idempotent signed webhooks', async () => {
    const cat = await reqJson('GET', '/api/catalogue');
    const room201 = cat.data.rooms.find((r) => r.roomNumber === '201');

    // 1. Tokenise a declined card ending in 0002
    const declineTok = await reqJson('POST', '/api/payments/tokenise', {
      cardholderName: 'DECLINE TEST',
      cardNumber: '4000000000000002',
      expiryMonth: '05',
      expiryYear: '2028',
      cvv: '123'
    });
    assert.equal(declineTok.status, 201);

    const failedBooking = await reqJson('POST', '/api/bookings', {
      roomIds: [room201.id],
      checkIn: '2026-11-20',
      checkOut: '2026-11-22',
      adults: 2,
      guestFirstName: 'Declined',
      guestLastName: 'Guest',
      guestEmail: 'declined@example.com',
      guestPhone: '+41 22 111 2222',
      paymentMethod: 'card',
      paymentToken: declineTok.data.tokenId
    });
    assert.equal(failedBooking.status, 402);

    // 2. Book with 30% Deposit + Luxury Addon + Promo Code AURELIA10
    const validTok = await reqJson('POST', '/api/payments/tokenise', {
      cardholderName: 'CLAIRE DUBOIS',
      cardNumber: '4532015112834242',
      expiryMonth: '09',
      expiryYear: '2029',
      cvv: '456'
    });

    const depositBooking = await reqJson('POST', '/api/bookings', {
      roomIds: [room201.id],
      checkIn: '2026-11-20',
      checkOut: '2026-11-23',
      adults: 2,
      guestFirstName: 'Claire',
      guestLastName: 'Dubois',
      guestEmail: 'claire.dubois@example.com',
      guestPhone: '+33 1 42 68 55 00',
      selectedAddons: ['CHAUFFEUR_RR'],
      promoCode: 'AURELIA10',
      paymentMethod: 'card',
      paymentPlan: 'deposit',
      paymentToken: validTok.data.tokenId
    });
    assert.equal(depositBooking.status, 201);
    const resObj = depositBooking.data.reservation;
    assert.equal(resObj.payment_status, 'deposit_paid');
    assert.ok(resObj.discount_amount > 0, 'Promo code discount applied');
    assert.ok(resObj.extras_subtotal === 280, 'Rolls-Royce Chauffeur addon included');
    assert.ok(resObj.amount_paid < resObj.total_amount, 'Only 30% deposit charged initially');

    // 3. Test Webhook with invalid signature -> 401
    const webhookPayload = {
      eventId: 'evt_test_balance_001',
      eventType: 'payment.succeeded',
      bookingReference: resObj.booking_reference,
      paymentReference: 'PAY-WHK-9901',
      amount: Number((resObj.total_amount - resObj.amount_paid).toFixed(2))
    };

    const badWebhook = await reqJson('POST', '/api/payments/webhook', webhookPayload, {
      'x-payment-signature': 'deadbeef0000'
    });
    assert.equal(badWebhook.status, 401);

    // 4. Send validly signed webhook -> settles balance to 'paid'
    const validSig = signWebhookPayload(webhookPayload);
    const goodWebhook = await reqJson('POST', '/api/payments/webhook', webhookPayload, {
      'x-payment-signature': validSig
    });
    assert.equal(goodWebhook.status, 200);
    assert.equal(goodWebhook.data.processed, true);
    assert.equal(goodWebhook.data.duplicate, false);

    // 5. Replay exact same webhook -> idempotently ignored
    const replayWebhook = await reqJson('POST', '/api/payments/webhook', webhookPayload, {
      'x-payment-signature': validSig
    });
    assert.equal(replayWebhook.status, 200);
    assert.equal(replayWebhook.data.duplicate, true);
  });

  it('7. Processes guest cancellation, issues policy refund, and immediately releases physical room inventory', async () => {
    const cat = await reqJson('GET', '/api/catalogue');
    const room301 = cat.data.rooms.find((r) => r.roomNumber === '301');

    const validTok = await reqJson('POST', '/api/payments/tokenise', {
      cardholderName: 'MARCUS VANCE',
      cardNumber: '4532015112834242',
      expiryMonth: '10',
      expiryYear: '2029',
      cvv: '777'
    });

    const bookRes = await reqJson('POST', '/api/bookings', {
      roomIds: [room301.id],
      checkIn: '2026-12-01',
      checkOut: '2026-12-04',
      adults: 2,
      guestFirstName: 'Marcus',
      guestLastName: 'Vance',
      guestEmail: 'marcus.vance@example.com',
      guestPhone: '+1 212 555 0199',
      paymentMethod: 'card',
      paymentPlan: 'full',
      paymentToken: validTok.data.tokenId
    });
    assert.equal(bookRes.status, 201);
    const ref = bookRes.data.bookingReference;

    // Cancel booking
    const cancelRes = await reqJson('POST', `/api/bookings/${ref}/cancel`, {
      email: 'marcus.vance@example.com',
      reason: 'Change of travel itinerary'
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.data.cancelled, true);
    assert.equal(cancelRes.data.reservation.status, 'cancelled');
    assert.equal(cancelRes.data.reservation.payment_status, 'refunded');
    assert.equal(cancelRes.data.refundAmount, bookRes.data.reservation.total_amount);

    // Verify Room #301 is immediately available again for 2026-12-01 to 2026-12-04
    const searchAfterCancel = await reqJson('POST', '/api/availability/search', {
      checkIn: '2026-12-01',
      checkOut: '2026-12-04',
      adults: 2
    });
    const room301After = searchAfterCancel.data.rooms.find((r) => r.id === room301.id);
    assert.equal(room301After.isAvailable, true);
  });

  it('8. Enforces Role-Based Access Control (RBAC) across Admin, Receptionist, and Finance staff roles, plus Maintenance Blocks & Backups', async () => {
    // Login as Receptionist
    const recLogin = await reqJson('POST', '/api/auth/login', {
      email: 'frontdesk@maisonaurelia.luxury',
      password: 'AureliaDesk!2026'
    });
    assert.equal(recLogin.status, 200);
    const recToken = recLogin.data.token;

    // Receptionist tries to modify hotel tax settings -> must be forbidden (403)
    const forbiddenSettings = await reqJson(
      'PUT',
      '/api/admin/settings',
      { taxRatePercent: 5 },
      { Authorization: `Bearer ${recToken}` }
    );
    assert.equal(forbiddenSettings.status, 403);

    // Login as Admin
    const adminLogin = await reqJson('POST', '/api/auth/login', {
      email: 'admin@maisonaurelia.luxury',
      password: 'AureliaAdmin!2026'
    });
    assert.equal(adminLogin.status, 200);
    const adminToken = adminLogin.data.token;

    // Admin adds a new physical room (#801)
    const cat = await reqJson('GET', '/api/catalogue');
    const suiteCat = cat.data.categories.find((c) => c.slug === 'luxury-suites');

    const newRoomRes = await reqJson(
      'POST',
      '/api/admin/rooms',
      {
        roomNumber: '801',
        name: 'Imperial Panoramic Salon #801',
        categoryId: suiteCat.id,
        floor: 8,
        pricePerNight: 1650
      },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.equal(newRoomRes.status, 201);
    assert.equal(newRoomRes.data.room.isSampleInventory, false);

    // Admin creates a maintenance block on Room #801 for 2026-12-10 to 2026-12-15
    const maintRes = await reqJson(
      'POST',
      '/api/admin/maintenance',
      {
        roomId: newRoomRes.data.room.id,
        startDate: '2026-12-10',
        endDate: '2026-12-15',
        reason: 'Chandelier Restoration'
      },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.equal(maintRes.status, 201);

    // Verify Room #801 shows as unavailable during maintenance dates
    const searchMaint = await reqJson('POST', '/api/availability/search', {
      checkIn: '2026-12-11',
      checkOut: '2026-12-13',
      adults: 2
    });
    const room801Status = searchMaint.data.rooms.find((r) => r.id === newRoomRes.data.room.id);
    assert.equal(room801Status.isAvailable, false);
    assert.equal(room801Status.unavailabilityReason, 'MAINTENANCE_BLOCK');
  });

  it('9. Supports permitted reservation date modifications and blocks modifications into conflicting dates', async () => {
    const cat = await reqJson('GET', '/api/catalogue');
    const room401 = cat.data.rooms.find((r) => r.roomNumber === '401');

    const tok = await reqJson('POST', '/api/payments/tokenise', {
      cardholderName: 'SOPHIA LOREN',
      cardNumber: '4532015112834242',
      expiryMonth: '11',
      expiryYear: '2029',
      cvv: '888'
    });

    const book1 = await reqJson('POST', '/api/bookings', {
      roomIds: [room401.id],
      checkIn: '2027-01-10',
      checkOut: '2027-01-12',
      adults: 2,
      guestFirstName: 'Sophia',
      guestLastName: 'Loren',
      guestEmail: 'sophia@example.com',
      guestPhone: '+39 06 555 0101',
      paymentMethod: 'card',
      paymentToken: tok.data.tokenId
    });
    assert.equal(book1.status, 201);

    // Extend stay from 2027-01-12 to 2027-01-14 (permitted & available)
    const modOk = await reqJson('POST', `/api/bookings/${book1.data.bookingReference}/modify-dates`, {
      email: 'sophia@example.com',
      newCheckIn: '2027-01-10',
      newCheckOut: '2027-01-14'
    });
    assert.equal(modOk.status, 200);
    assert.equal(modOk.data.reservation.nights, 4);
    assert.equal(modOk.data.reservation.check_out, '2027-01-14');

    // Another guest books 2027-01-14 to 2027-01-16 on the same room
    const book2 = await reqJson('POST', '/api/bookings', {
      roomIds: [room401.id],
      checkIn: '2027-01-14',
      checkOut: '2027-01-16',
      adults: 2,
      guestFirstName: 'Carlo',
      guestLastName: 'Ponti',
      guestEmail: 'carlo@example.com',
      guestPhone: '+39 06 555 0102',
      paymentMethod: 'card',
      paymentToken: tok.data.tokenId
    });
    assert.equal(book2.status, 201);

    // Now Sophia tries to extend her stay into 2027-01-15 -> must be rejected with 409 conflict!
    const modConflict = await reqJson('POST', `/api/bookings/${book1.data.bookingReference}/modify-dates`, {
      email: 'sophia@example.com',
      newCheckIn: '2027-01-10',
      newCheckOut: '2027-01-15'
    });
    assert.equal(modConflict.status, 409);
  });

  it('10. Enforces CSRF token validation, XSS input sanitisation, and Multi-Room atomic reservations', async () => {
    // 1. Invalid CSRF token is rejected with 403
    const badCsrf = await reqJson(
      'POST',
      '/api/availability/search',
      { checkIn: '2027-02-01', checkOut: '2027-02-03' },
      { 'x-csrf-token': 'invalid.token.signature' }
    );
    assert.equal(badCsrf.status, 403);
    assert.equal(badCsrf.data.error, 'INVALID_CSRF_TOKEN');

    // 2. Valid CSRF token + Multi-Room Booking + Input Sanitisation
    const csrfRes = await reqJson('GET', '/api/csrf-token');
    assert.equal(csrfRes.status, 200);
    const validCsrf = csrfRes.data.csrfToken;

    const cat = await reqJson('GET', '/api/catalogue');
    const room501 = cat.data.rooms.find((r) => r.roomNumber === '501');
    const room502 = cat.data.rooms.find((r) => r.roomNumber === '502');

    const multiBook = await reqJson(
      'POST',
      '/api/bookings',
      {
        roomIds: [room501.id, room502.id],
        checkIn: '2027-02-10',
        checkOut: '2027-02-12',
        adults: 4,
        children: 1,
        guestFirstName: 'Lord <script>alert(1)</script>Arthur',
        guestLastName: 'Pendelton',
        guestEmail: 'arthur.pendelton@example.com',
        guestPhone: '+44 20 7946 0000',
        specialRequests: 'Quiet wing please <script>evil()</script>',
        paymentMethod: 'pay_at_hotel'
      },
      { 'x-csrf-token': validCsrf }
    );
    assert.equal(multiBook.status, 201);
    assert.equal(multiBook.data.reservation.rooms.length, 2);
    assert.equal(multiBook.data.reservation.guest_first_name, 'Lord Arthur');
    assert.ok(!multiBook.data.reservation.special_requests.includes('<script>'));
  });

  it('11. Generates 14-day room availability strips, Front-Desk Tape Chart matrix, and RFC 5545 iCal (.ics) feeds', async () => {
    const cat = await reqJson('GET', '/api/catalogue');
    const presRoom = cat.data.rooms.find((r) => r.roomNumber === '701');

    // 1. 14-Day Room Availability Strip
    const stripRes = await reqJson('GET', `/api/rooms/${presRoom.id}/availability-strip?startDate=2026-11-08&days=10&currency=GBP`);
    assert.equal(stripRes.status, 200);
    assert.equal(stripRes.data.strip.length, 10);
    const bookedDay = stripRes.data.strip.find((d) => d.date === '2026-11-10');
    assert.equal(bookedDay.available, false);

    // 2. iCal (.ics) Feed
    const icsRes = await fetch(`${baseUrl}/api/rooms/${presRoom.id}/calendar.ics`);
    assert.equal(icsRes.status, 200);
    assert.ok(icsRes.headers.get('content-type').includes('text/calendar'));
    const icsText = await icsRes.text();
    assert.ok(icsText.includes('BEGIN:VCALENDAR'));
    assert.ok(icsText.includes('BEGIN:VEVENT'));
    assert.ok(icsText.includes('DTSTART;VALUE=DATE:20261110'));

    // 3. Admin 14-Day Tape Chart
    const adminLogin = await reqJson('POST', '/api/auth/login', {
      email: 'admin@maisonaurelia.luxury',
      password: 'AureliaAdmin!2026'
    });
    const tapeRes = await reqJson(
      'GET',
      '/api/admin/tape-chart?startDate=2026-11-08&days=14',
      null,
      { Authorization: `Bearer ${adminLogin.data.token}` }
    );
    assert.equal(tapeRes.status, 200);
    assert.equal(tapeRes.data.dateHeaders.length, 14);
    assert.ok(tapeRes.data.rows.length >= 17);
  });

  it('12. Enforces Housekeeping Turnover Readiness before Check-In and transitions rooms to dirty_turnover on Check-Out', async () => {
    const adminLogin = await reqJson('POST', '/api/auth/login', {
      email: 'admin@maisonaurelia.luxury',
      password: 'AureliaAdmin!2026'
    });
    const adminToken = adminLogin.data.token;

    const cat = await reqJson('GET', '/api/catalogue');
    const room102 = cat.data.rooms.find((r) => r.roomNumber === '102');

    // Create a confirmed booking on Room #102
    const bookRes = await reqJson('POST', '/api/bookings', {
      roomIds: [room102.id],
      checkIn: '2027-03-01',
      checkOut: '2027-03-03',
      adults: 2,
      guestFirstName: 'Genevieve',
      guestLastName: 'Moreau',
      guestEmail: 'genevieve@example.com',
      guestPhone: '+33 1 55 00 11 22',
      paymentMethod: 'pay_at_hotel'
    });
    assert.equal(bookRes.status, 201);
    const ref = bookRes.data.bookingReference;

    // Mark Room #102 as 'dirty_turnover'
    const hkDirty = await reqJson(
      'PATCH',
      `/api/admin/rooms/${room102.id}/housekeeping`,
      { housekeepingStatus: 'dirty_turnover' },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.equal(hkDirty.status, 200);
    assert.equal(hkDirty.data.room.housekeepingStatus, 'dirty_turnover');

    // Attempt to Check-In guest while room is dirty_turnover -> must fail with 409 HOUSEKEEPING_NOT_READY
    const blockedCheckIn = await reqJson(
      'POST',
      `/api/admin/reservations/${ref}/status`,
      { status: 'checked_in' },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.equal(blockedCheckIn.status, 409);
    assert.equal(blockedCheckIn.data.error, 'HOUSEKEEPING_NOT_READY');

    // Housekeeping marks Room #102 as 'clean_inspected'
    await reqJson(
      'PATCH',
      `/api/admin/rooms/${room102.id}/housekeeping`,
      { housekeepingStatus: 'clean_inspected' },
      { Authorization: `Bearer ${adminToken}` }
    );

    // Now Check-In succeeds
    const okCheckIn = await reqJson(
      'POST',
      `/api/admin/reservations/${ref}/status`,
      { status: 'checked_in' },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.equal(okCheckIn.status, 200);
    assert.equal(okCheckIn.data.reservation.status, 'checked_in');

    // Now Check-Out guest -> Room #102 must automatically transition to 'dirty_turnover'
    const okCheckOut = await reqJson(
      'POST',
      `/api/admin/reservations/${ref}/status`,
      { status: 'checked_out' },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.equal(okCheckOut.status, 200);
    assert.equal(okCheckOut.data.reservation.rooms[0].housekeeping_status, 'dirty_turnover');
  });

  it('13. Saves Digital Pre-Arrival Butler Dossier, posts In-Stay Incidental Folio Charges, and publishes Verified Guest Reviews', async () => {
    const adminLogin = await reqJson('POST', '/api/auth/login', {
      email: 'admin@maisonaurelia.luxury',
      password: 'AureliaAdmin!2026'
    });
    const adminToken = adminLogin.data.token;

    const cat = await reqJson('GET', '/api/catalogue');
    const roomPH = cat.data.rooms.find((r) => r.roomNumber === 'PH-01');

    const bookRes = await reqJson('POST', '/api/bookings', {
      roomIds: [roomPH.id],
      checkIn: '2027-04-10',
      checkOut: '2027-04-12',
      adults: 2,
      guestFirstName: 'Lorenzo',
      guestLastName: 'Medici',
      guestEmail: 'lorenzo@medici.it',
      guestPhone: '+39 055 999 8888',
      paymentMethod: 'pay_at_hotel'
    });
    assert.equal(bookRes.status, 201);
    const ref = bookRes.data.bookingReference;

    // 1. Guest saves Pre-Arrival Butler Dossier
    const dossierRes = await reqJson('PUT', `/api/bookings/${ref}/dossier`, {
      email: 'lorenzo@medici.it',
      pillowPreference: 'Loro Piana Cashmere Neck Roll',
      suiteTemperatureC: 20.5,
      turndownScent: 'Swiss Stone Pine & Atlas Cedar',
      arrivalTransportMode: 'Rooftop Helipad Arrival',
      flightOrTailNumber: 'I-MEDI (AW139 Helicopter)',
      dietaryAllergies: 'No shellfish'
    });
    assert.equal(dossierRes.status, 200);
    assert.equal(dossierRes.data.preArrivalDossier.pillow_preference, 'Loro Piana Cashmere Neck Roll');
    assert.ok(dossierRes.data.preArrivalDossier.digital_key_code.startsWith(`KEY-${ref}`));

    // 2. Staff posts an In-Stay Incidental Folio Charge ($390 × 2 = $780)
    const folioPost = await reqJson(
      'POST',
      `/api/admin/reservations/${ref}/folio`,
      {
        category: 'Sommelier Wine Cellar',
        description: 'Château Margaux Premier Grand Cru Classé',
        unitPrice: 390,
        quantity: 2
      },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.equal(folioPost.status, 201);
    assert.equal(folioPost.data.reservation.incidentalTotal, 780);
    assert.equal(
      folioPost.data.reservation.grandFolioTotal,
      Number((folioPost.data.reservation.total_amount + 780).toFixed(2))
    );

    // 3. Guest submits a Verified 5-Star Stay Review
    const revRes = await reqJson('POST', `/api/bookings/${ref}/review`, {
      email: 'lorenzo@medici.it',
      rating: 5,
      title: 'Peerless Sky Crown Penthouse Experience',
      comment: 'The rooftop infinity plunge pool and helicopter arrival coordination were extraordinary.'
    });
    assert.equal(revRes.status, 201);
    assert.equal(revRes.data.review.rating, 5);
  });

  it('14. Books Michelin Dining & Thermal Spa slots with collision protection, auto-posts folio charges, and voids folio charges', async () => {
    const adminLogin = await reqJson('POST', '/api/auth/login', {
      email: 'admin@maisonaurelia.luxury',
      password: 'AureliaAdmin!2026'
    });
    const adminToken = adminLogin.data.token;

    const cat = await reqJson('GET', '/api/catalogue');
    const room301 = cat.data.rooms.find((r) => r.roomNumber === '301');

    const bookRes = await reqJson('POST', '/api/bookings', {
      roomIds: [room301.id],
      checkIn: '2027-05-10',
      checkOut: '2027-05-13',
      adults: 2,
      guestFirstName: 'Camille',
      guestLastName: 'Laurent',
      guestEmail: 'camille.laurent@example.com',
      guestPhone: '+33 6 11 22 33 44',
      paymentMethod: 'pay_at_hotel'
    });
    assert.equal(bookRes.status, 201);
    const ref = bookRes.data.bookingReference;

    // 1. Reserve a Michelin Dining time slot ($240)
    const slotRes = await reqJson('POST', `/api/bookings/${ref}/facilities`, {
      email: 'camille.laurent@example.com',
      facilityType: 'michelin_dining',
      reservationDate: '2027-05-11',
      slotTime: '19:30',
      guestsCount: 2,
      treatmentOrMenu: 'Chef Tasting Table & Krug Pairing',
      price: 240
    });
    assert.equal(slotRes.status, 201);
    assert.equal(slotRes.data.reservation.facilityBookings.length, 1);
    assert.equal(slotRes.data.reservation.incidentalTotal, 240);

    // 2. Attempting to book the exact same venue, date, and time slot is rejected with 409 FACILITY_SLOT_ALREADY_BOOKED
    const dupSlot = await reqJson('POST', `/api/bookings/${ref}/facilities`, {
      email: 'camille.laurent@example.com',
      facilityType: 'michelin_dining',
      reservationDate: '2027-05-11',
      slotTime: '19:30',
      guestsCount: 2,
      treatmentOrMenu: 'Second Table Request',
      price: 240
    });
    assert.equal(dupSlot.status, 409);
    assert.equal(dupSlot.data.error, 'FACILITY_SLOT_ALREADY_BOOKED');

    // 3. Void the incidental folio charge via Admin API
    const folioId = slotRes.data.reservation.folioCharges[0].id;
    const voidRes = await reqJson(
      'DELETE',
      `/api/admin/reservations/${ref}/folio/${folioId}`,
      null,
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.equal(voidRes.status, 200);
    assert.equal(voidRes.data.reservation.incidentalTotal, 0);

    // 4. Cancel the facility slot
    const slotId = slotRes.data.reservation.facilityBookings[0].id;
    const cancelSlotRes = await reqJson(
      'DELETE',
      `/api/bookings/${ref}/facilities/${slotId}?email=camille.laurent%40example.com`
    );
    assert.equal(cancelSlotRes.status, 200);
    assert.equal(cancelSlotRes.data.reservation.facilityBookings.length, 0);
  });

  it('15. Applies Dynamic Occupancy-Threshold Yield Pricing and imports inbound RFC 5545 iCal (.ics) channel feeds', async () => {
    const adminLogin = await reqJson('POST', '/api/auth/login', {
      email: 'admin@maisonaurelia.luxury',
      password: 'AureliaAdmin!2026'
    });
    const adminToken = adminLogin.data.token;

    const cat = await reqJson('GET', '/api/catalogue');
    // Standard Courtyard Queen has 2 rooms (#101 and #102)
    const room101 = cat.data.rooms.find((r) => r.roomNumber === '101');
    const room102 = cat.data.rooms.find((r) => r.roomNumber === '102');

    // Configure dynamic yield: 50% threshold, 1.20x high-demand multiplier
    const setRes = await reqJson(
      'PUT',
      '/api/admin/settings',
      {
        dynamicYieldEnabled: true,
        highDemandOccupancyThreshold: 50,
        highDemandMultiplier: 1.20
      },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.equal(setRes.status, 200);

    // Book Room #101 for 2027-06-10 -> 2027-06-12 (now 1 of 2 rooms in category is booked = 50% occupancy)
    const b1 = await reqJson('POST', '/api/bookings', {
      roomIds: [room101.id],
      checkIn: '2027-06-10',
      checkOut: '2027-06-12',
      adults: 2,
      guestFirstName: 'Yield',
      guestLastName: 'Tester',
      guestEmail: 'yield@example.com',
      guestPhone: '+41 22 000 0000',
      paymentMethod: 'pay_at_hotel'
    });
    assert.equal(b1.status, 201);

    // Now check availability & pricing for Room #102 on 2027-06-10 -> 2027-06-12: dynamic yield (1.20x) must be active!
    const check102 = await reqJson('GET', `/api/rooms/${room102.id}?checkIn=2027-06-10&checkOut=2027-06-12`);
    assert.equal(check102.status, 200);
    assert.equal(check102.data.availability.available, true);
    assert.ok(
      check102.data.availability.pricing.roomBreakdowns[0].seasonBadges.includes('High-Demand Yield (+20%)')
    );
    assert.ok(
      check102.data.availability.pricing.roomBreakdowns[0].effectiveNightlyRate >
      check102.data.availability.pricing.roomBreakdowns[0].baseNightlyRate
    );

    // Inbound iCal (.ics) Channel Sync Import on Room #102 for 2027-07-01 -> 2027-07-04
    const icsPayload = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'DTSTART;VALUE=DATE:20270701',
      'DTEND;VALUE=DATE:20270704',
      'SUMMARY:Virtuoso Channel Reservation',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const importRes = await reqJson(
      'POST',
      `/api/admin/rooms/${room102.id}/ical-import`,
      { channelName: 'Virtuoso OTA', icsContent: icsPayload },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.equal(importRes.status, 201);
    assert.equal(importRes.data.importedCount, 1);

    // Verify Room #102 is now blocked on 2027-07-01 -> 2027-07-04
    const afterImport = await reqJson('GET', `/api/rooms/${room102.id}?checkIn=2027-07-01&checkOut=2027-07-04`);
    assert.equal(afterImport.data.availability.available, false);
  });

  it('16. Verifies Admin CRUD for Seasonal Rates, Promo Codes, Notification Templates, Staff Roles, and Cloud Adapter Handshakes', async () => {
    const adminLogin = await reqJson('POST', '/api/auth/login', {
      email: 'admin@maisonaurelia.luxury',
      password: 'AureliaAdmin!2026'
    });
    const adminToken = adminLogin.data.token;

    // 1. Create & Delete Seasonal Rate
    const srCreate = await reqJson(
      'POST',
      '/api/admin/seasonal-rates',
      { name: 'Autumn Regatta', startDate: '2027-09-01', endDate: '2027-09-10', multiplier: 1.25 },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.equal(srCreate.status, 201);
    const srDel = await reqJson(
      'DELETE',
      `/api/admin/seasonal-rates/${srCreate.data.seasonalRate.id}`,
      null,
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.equal(srDel.status, 200);

    // 2. Create & Delete Promo Code
    const pcCreate = await reqJson(
      'POST',
      '/api/admin/promo-codes',
      { code: 'REGATTA20', description: '20% Regatta Privilege', discountType: 'percent', discountValue: 20, minNights: 2 },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.equal(pcCreate.status, 201);
    const pcDel = await reqJson(
      'DELETE',
      `/api/admin/promo-codes/${pcCreate.data.promoCode.id}`,
      null,
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.equal(pcDel.status, 200);

    // 3. Update Notification Template
    const tplUpdate = await reqJson(
      'PUT',
      '/api/admin/templates/BOOKING_CONFIRMED',
      {
        subjectTemplate: 'Maison Aurélia — Confirmed Dossier {{bookingReference}}',
        bodyTemplate: 'Dear {{guestName}}, your reservation {{bookingReference}} ({{checkIn}} to {{checkOut}}) is confirmed.'
      },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.equal(tplUpdate.status, 200);

    // 4. Cloud Adapter Status & Handshake Test
    const intStatus = await reqJson('GET', '/api/admin/integrations', null, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(intStatus.status, 200);
    assert.ok(intStatus.data.paymentGateways.length >= 2);

    const handshake = await reqJson(
      'POST',
      '/api/admin/integrations/test',
      { adapterId: 'stripe' },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.equal(handshake.status, 200);
    assert.equal(handshake.data.status, 'verified');
  });

  it('17. Enrolls guests on Priority Room Waitlist and automatically dispatches release alerts when conflicting reservations cancel', async () => {
    const adminLogin = await reqJson('POST', '/api/auth/login', {
      email: 'admin@maisonaurelia.luxury',
      password: 'AureliaAdmin!2026'
    });
    const adminToken = adminLogin.data.token;

    const cat = await reqJson('GET', '/api/catalogue');
    const room401 = cat.data.rooms.find((r) => r.roomNumber === '401');

    // 1. First guest reserves Room #401 for 2027-08-10 -> 2027-08-13
    const firstBook = await reqJson('POST', '/api/bookings', {
      roomIds: [room401.id],
      checkIn: '2027-08-10',
      checkOut: '2027-08-13',
      adults: 2,
      guestFirstName: 'Primary',
      guestLastName: 'Holder',
      guestEmail: 'primary.holder@example.com',
      guestPhone: '+41 22 700 1111',
      paymentMethod: 'pay_at_hotel'
    });
    assert.equal(firstBook.status, 201);
    const ref = firstBook.data.bookingReference;

    // 2. Second guest joins Priority Waitlist for Room #401 on 2027-08-10 -> 2027-08-13
    const wlRes = await reqJson('POST', '/api/waitlist', {
      roomId: room401.id,
      guestName: 'Duchess Sofia Rossi',
      guestEmail: 'sofia.rossi@example.com',
      guestPhone: '+39 02 1234 5678',
      checkIn: '2027-08-10',
      checkOut: '2027-08-13',
      adults: 2
    });
    assert.equal(wlRes.status, 201);
    assert.equal(wlRes.data.waitlistEntry.status, 'waiting');
    const wlRef = wlRes.data.waitlistEntry.waitlist_reference;

    // 3. First guest cancels their reservation -> Waitlist entry must automatically transition to 'notified'
    const cancelRes = await reqJson('POST', `/api/bookings/${ref}/cancel`, {
      email: 'primary.holder@example.com',
      reason: 'Schedule change'
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.data.notifiedWaitlist.length, 1);
    assert.equal(cancelRes.data.notifiedWaitlist[0].waitlist_reference, wlRef);
    assert.equal(cancelRes.data.notifiedWaitlist[0].status, 'notified');

    // Verify in Admin Waitlist endpoint
    const adminWl = await reqJson('GET', '/api/admin/waitlist', null, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(adminWl.status, 200);
    const matched = adminWl.data.waitlist.find((w) => w.waitlist_reference === wlRef);
    assert.equal(matched.status, 'notified');
  });

  it('18. Redeems VIP Loyalty Points at checkout for instant credit and generates Printable Official Tax & Folio Invoices', async () => {
    // Sign in as VIP Guest (Elena Rostova has 18,400 loyalty points seeded)
    const guestLogin = await reqJson('POST', '/api/auth/login', {
      email: 'elena.rostova@example.com',
      password: 'GuestPass!2026'
    });
    assert.equal(guestLogin.status, 200);
    const guestToken = guestLogin.data.token;

    const cat = await reqJson('GET', '/api/catalogue');
    const room501 = cat.data.rooms.find((r) => r.roomNumber === '501');

    // 1. Calculate pricing with redeemLoyaltyPoints: true
    const priceRes = await reqJson(
      'POST',
      '/api/pricing/calculate',
      {
        roomIds: [room501.id],
        checkIn: '2027-10-05',
        checkOut: '2027-10-08',
        adults: 2,
        redeemLoyaltyPoints: true
      },
      { Authorization: `Bearer ${guestToken}` }
    );
    assert.equal(priceRes.status, 200);
    assert.ok(priceRes.data.pricing.loyaltyPointsRedeemed > 0);
    assert.ok(priceRes.data.pricing.loyaltyDiscountAmount > 0);

    // 2. Confirm reservation with redeemLoyaltyPoints: true
    const bookRes = await reqJson(
      'POST',
      '/api/bookings',
      {
        roomIds: [room501.id],
        checkIn: '2027-10-05',
        checkOut: '2027-10-08',
        adults: 2,
        guestFirstName: 'Elena',
        guestLastName: 'Rostova',
        guestEmail: 'elena.rostova@example.com',
        guestPhone: '+44 20 7946 0921',
        redeemLoyaltyPoints: true,
        paymentMethod: 'pay_at_hotel'
      },
      { Authorization: `Bearer ${guestToken}` }
    );
    assert.equal(bookRes.status, 201);
    assert.ok(bookRes.data.reservation.loyalty_points_redeemed > 0);
    assert.ok(bookRes.data.reservation.loyalty_discount_amount > 0);

    // 3. Generate Printable Official Tax & Folio Invoice (JSON & HTML formats)
    const ref = bookRes.data.bookingReference;
    const invJson = await reqJson('GET', `/api/bookings/${ref}/invoice`);
    assert.equal(invJson.status, 200);
    assert.equal(invJson.data.bookingReference, ref);
    assert.ok(invJson.data.html.includes('OFFICIAL TAX &amp; FOLIO INVOICE'));

    const invHtmlRes = await fetch(`${baseUrl}/api/bookings/${ref}/invoice?format=html`);
    assert.equal(invHtmlRes.status, 200);
    assert.ok(invHtmlRes.headers.get('content-type').includes('text/html'));
  });

  it('19. Records Housekeeping Attendant Inspection Checklists and streams Real-Time Front-Desk SSE Events', async () => {
    const adminLogin = await reqJson('POST', '/api/auth/login', {
      email: 'admin@maisonaurelia.luxury',
      password: 'AureliaAdmin!2026'
    });
    const adminToken = adminLogin.data.token;

    const cat = await reqJson('GET', '/api/catalogue');
    const room201 = cat.data.rooms.find((r) => r.roomNumber === '201');

    // 1. Submit Housekeeping Attendant Checklist
    const hkRes = await reqJson(
      'POST',
      `/api/admin/rooms/${room201.id}/housekeeping-checklist`,
      {
        attendantName: 'Marie-Claire Laurent',
        housekeepingStatus: 'turndown_complete',
        linenChanged: true,
        marbleSanitised: true,
        minibarRestocked: true,
        floralsRefreshed: true,
        supervisorVerified: true,
        notes: 'Evening turndown with Grasse jasmine mist complete'
      },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.equal(hkRes.status, 201);
    assert.equal(hkRes.data.checklist.attendant_name, 'Marie-Claire Laurent');
    assert.equal(hkRes.data.room.housekeeping_status, 'turndown_complete');

    // 2. Verify Housekeeping Checklists log
    const hkList = await reqJson('GET', '/api/admin/housekeeping', null, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(hkList.status, 200);
    assert.ok(hkList.data.checklists.length >= 1);

    // 3. Verify Real-Time Front-Desk SSE Event Feed
    const sseRecent = await reqJson('GET', '/api/admin/events/recent', null, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(sseRecent.status, 200);
    assert.ok(sseRecent.data.events.some((e) => e.type === 'HOUSEKEEPING_UPDATED'));
  });

  it('20. Serves Complete Users Dashboard (Loyalty Wallet, Profile, Concierge Desk) and Admin Users/Concierge/Payments CRUD', async () => {
    const guestLogin = await reqJson('POST', '/api/auth/login', {
      email: 'elena.rostova@example.com',
      password: 'GuestPass!2026'
    });
    assert.equal(guestLogin.status, 200);
    const guestToken = guestLogin.data.token;

    const adminLogin = await reqJson('POST', '/api/auth/login', {
      email: 'admin@maisonaurelia.luxury',
      password: 'AureliaAdmin!2026'
    });
    const adminToken = adminLogin.data.token;

    // 1. Guest Dashboard KPIs & Loyalty Wallet
    const dashRes = await reqJson('GET', '/api/guest/dashboard', null, {
      Authorization: `Bearer ${guestToken}`
    });
    assert.equal(dashRes.status, 200);
    assert.ok(dashRes.data.metrics.loyaltyPoints > 0);
    assert.ok(dashRes.data.metrics.totalStays >= 1);

    // 2. Guest Updates Profile Details
    const profRes = await reqJson(
      'PUT',
      '/api/guest/profile',
      {
        firstName: 'Elena',
        lastName: 'Rostova-Valois',
        phone: '+41 22 888 9999',
        country: 'Switzerland'
      },
      { Authorization: `Bearer ${guestToken}` }
    );
    assert.equal(profRes.status, 200);
    assert.equal(profRes.data.user.last_name, 'Rostova-Valois');

    // 3. Guest Submits VIP Concierge Service Request
    const concRes = await reqJson(
      'POST',
      '/api/guest/concierge-requests',
      {
        category: 'Chauffeur & Aviation',
        priority: 'vip_urgent',
        subject: 'Rolls-Royce Phantom VIII Pickup at Geneva Private Jet Terminal',
        details: 'Arriving on Gulfstream G650 tail HB-JVA at 16:00',
        preferredTime: '16:00'
      },
      { Authorization: `Bearer ${guestToken}` }
    );
    assert.equal(concRes.status, 201);
    const reqId = concRes.data.conciergeRequest.id;

    // 4. Admin Fulfills Concierge Request & Dispatches Notification to Guest
    const admConcPatch = await reqJson(
      'PATCH',
      `/api/admin/concierge-requests/${reqId}`,
      {
        status: 'fulfilled',
        staffNotes: 'Chauffeur Jean-Luc assigned with chilled Krug Grande Cuvée on board.'
      },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.equal(admConcPatch.status, 200);
    assert.equal(admConcPatch.data.conciergeRequest.status, 'fulfilled');

    // 5. Admin Creates, Updates (Tier & Points), and Deletes a User Account
    const createUserRes = await reqJson(
      'POST',
      '/api/admin/users',
      {
        firstName: 'Lord Julian',
        lastName: 'Vance',
        email: 'julian.vance@example.com',
        role: 'guest',
        loyaltyTier: 'Gold Sanctuary',
        loyaltyPoints: 6500,
        password: 'JulianPassword!2026'
      },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.equal(createUserRes.status, 201);
    const newUserId = createUserRes.data.user.id;

    const updateUserRes = await reqJson(
      'PUT',
      `/api/admin/users/${newUserId}`,
      {
        role: 'guest',
        loyaltyTier: 'Imperial Black',
        loyaltyPoints: 16000,
        isActive: true
      },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.equal(updateUserRes.status, 200);
    assert.equal(updateUserRes.data.user.loyalty_tier, 'Imperial Black');
    assert.equal(updateUserRes.data.user.loyalty_points, 16000);

    const delUserRes = await reqJson(
      'DELETE',
      `/api/admin/users/${newUserId}`,
      null,
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.equal(delUserRes.status, 200);

    // 6. Admin Financial Payments Ledger
    const payLedger = await reqJson('GET', '/api/admin/payments', null, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(payLedger.status, 200);
    assert.ok(Array.isArray(payLedger.data.payments));
  });

  it('21. Supports Complete Two-Way Messaging Inbox between Users and Admin with unread tracking and instant replies', async () => {
    const guestLogin = await reqJson('POST', '/api/auth/login', {
      email: 'elena.rostova@example.com',
      password: 'GuestPass!2026'
    });
    assert.equal(guestLogin.status, 200);
    const guestToken = guestLogin.data.token;

    const adminLogin = await reqJson('POST', '/api/auth/login', {
      email: 'admin@maisonaurelia.luxury',
      password: 'AureliaAdmin!2026'
    });
    assert.equal(adminLogin.status, 200);
    const adminToken = adminLogin.data.token;

    // 1. User starts a new message thread to Admin / Concierge
    const startThread = await reqJson(
      'POST',
      '/api/guest/messages',
      {
        department: 'Head Concierge & Admin',
        bookingReference: 'AUR-2026-PRES01',
        priority: 'vip_urgent',
        subject: 'Private Riva Yacht Sunset Cruise & Sommelier Selection',
        message: 'Bonjour Admin, could we reserve the private Riva yacht for a 2-hour sunset cruise on Lake Geneva during our stay?'
      },
      { Authorization: `Bearer ${guestToken}` }
    );
    assert.equal(startThread.status, 201);
    assert.equal(startThread.data.thread.status, 'awaiting_staff');
    assert.equal(startThread.data.thread.unread_by_admin, 1);
    const threadId = startThread.data.thread.id;

    // 2. Admin lists inbox & opens the user's thread (clears unread_by_admin -> 0)
    const adminList = await reqJson('GET', '/api/admin/messages', null, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(adminList.status, 200);
    assert.ok(adminList.data.metrics.totalThreads >= 2);

    const adminOpen = await reqJson('GET', `/api/admin/messages/${threadId}`, null, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(adminOpen.status, 200);
    assert.equal(adminOpen.data.thread.unread_by_admin, 0);

    // 3. Admin replies to the user -> sets unread_by_guest = 1 and status = 'awaiting_guest'
    const adminReply = await reqJson(
      'POST',
      `/api/admin/messages/${threadId}/reply`,
      {
        body: 'Madame Rostova, our Captain has reserved the Riva Aquarama for 17:30 with Dom Pérignon P2 on board.',
        status: 'awaiting_guest'
      },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.equal(adminReply.status, 201);
    assert.equal(adminReply.data.thread.status, 'awaiting_guest');
    assert.equal(adminReply.data.thread.unread_by_guest, 1);
    assert.equal(adminReply.data.thread.messages.length, 2);

    // 4. User opens thread in Guest Messaging Inbox -> clears unread_by_guest -> 0 and sees Admin reply
    const guestRead = await reqJson('GET', `/api/guest/messages/${threadId}`, null, {
      Authorization: `Bearer ${guestToken}`
    });
    assert.equal(guestRead.status, 200);
    assert.equal(guestRead.data.thread.unread_by_guest, 0);
    assert.equal(guestRead.data.thread.messages[1].sender_role, 'admin');

    // 5. User sends a follow-up reply to Admin
    const guestReply = await reqJson(
      'POST',
      `/api/guest/messages/${threadId}/reply`,
      { body: 'Merci beaucoup! Please charge the yacht charter directly to our Presidential Suite folio.' },
      { Authorization: `Bearer ${guestToken}` }
    );
    assert.equal(guestReply.status, 201);
    assert.equal(guestReply.data.thread.status, 'awaiting_staff');
    assert.equal(guestReply.data.thread.unread_by_admin, 1);
    assert.equal(guestReply.data.thread.messages.length, 3);

    // 6. Admin marks the conversation resolved
    const resolveRes = await reqJson(
      'PATCH',
      `/api/admin/messages/${threadId}/status`,
      { status: 'resolved' },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.equal(resolveRes.status, 200);
    assert.equal(resolveRes.data.thread.status, 'resolved');

    // 7. Admin initiates a proactive thread to the guest, then marks all read & deletes test thread
    const adminInit = await reqJson(
      'POST',
      '/api/admin/messages',
      {
        guestEmail: 'elena.rostova@example.com',
        guestName: 'Elena Rostova',
        department: 'Head Concierge & Admin',
        subject: 'Complimentary Rolls-Royce Airport Transfer Confirmation',
        message: 'Dear Madame Rostova, our chauffeur will greet you at Gate VIP-1.'
      },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.equal(adminInit.status, 201);
    assert.equal(adminInit.data.thread.unread_by_guest, 1);

    const markGuestRead = await reqJson('POST', '/api/guest/messages/mark-all-read', {}, {
      Authorization: `Bearer ${guestToken}`
    });
    assert.equal(markGuestRead.status, 200);

    const markAdminRead = await reqJson('POST', '/api/admin/messages/mark-all-read', {}, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(markAdminRead.status, 200);

    const delThread = await reqJson('DELETE', `/api/admin/messages/${adminInit.data.thread.id}`, null, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(delThread.status, 200);
  });

  it('22. Routes Contact Page messages with Map Landmark metadata directly into the Admin Messaging Inbox and supports replies', async () => {
    const adminLogin = await reqJson('POST', '/api/auth/login', {
      email: 'admin@maisonaurelia.luxury',
      password: 'AureliaAdmin!2026'
    });
    const adminToken = adminLogin.data.token;

    // 1. Visitor / Guest submits a message from the Contact Page with a selected map landmark
    const contactSubmit = await reqJson('POST', '/api/contact/messages', {
      guestName: 'Lord Julian Sterling',
      guestEmail: 'julian.sterling@example.com',
      guestPhone: '+44 20 7946 0192',
      bookingReference: '',
      department: 'Private Aviation & Chauffeur',
      priority: 'vip_urgent',
      mapPoint: 'Maison Aurélia Sky Crown Helipad H1 (46.2088° N, 6.1502° E)',
      subject: 'Rooftop Helipad H1 Landing Slot & Presidential Suite Viewing',
      message: 'Arriving by helicopter from Zurich at 15:00. Please arrange rooftop security reception.'
    });
    assert.equal(contactSubmit.status, 201);
    assert.ok(contactSubmit.data.thread.thread_reference.startsWith('MSG-'));
    assert.equal(contactSubmit.data.thread.unread_by_admin, 1);
    assert.ok(contactSubmit.data.thread.messages[0].body.includes('Helipad H1'));

    const threadId = contactSubmit.data.thread.id;
    const threadRef = contactSubmit.data.thread.thread_reference;

    // 2. Verify the Contact Page message immediately appears in the Admin Messaging Inbox
    const adminInbox = await reqJson('GET', '/api/admin/messages', null, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(adminInbox.status, 200);
    const inAdmin = adminInbox.data.threads.find((t) => t.id === threadId);
    assert.ok(inAdmin, 'Contact Page thread must appear in Admin Messaging Inbox');
    assert.equal(inAdmin.unread_by_admin, 1);

    // 3. Admin replies to the Contact Page message from the Admin Inbox
    const adminReply = await reqJson(
      'POST',
      `/api/admin/messages/${threadId}/reply`,
      {
        body: 'Dear Lord Sterling, Helipad H1 (ICAO: LSMA) is cleared for your 15:00 arrival and our Palace Director awaits.',
        status: 'awaiting_guest'
      },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.equal(adminReply.status, 201);
    assert.equal(adminReply.data.thread.unread_by_guest, 1);

    // 4. Visitor looks up the thread on the Contact Page and sends a follow-up reply back to Admin Inbox
    const lookupRes = await reqJson(
      'GET',
      `/api/contact/messages/lookup?threadReference=${encodeURIComponent(threadRef)}&email=julian.sterling@example.com`
    );
    assert.equal(lookupRes.status, 200);
    assert.equal(lookupRes.data.thread.messages.length, 2);
    assert.equal(lookupRes.data.thread.unread_by_guest, 0);

    const followUp = await reqJson('POST', `/api/contact/messages/${threadRef}/reply`, {
      email: 'julian.sterling@example.com',
      body: 'Thank you, tail number G-AURE. See you at 15:00.'
    });
    assert.equal(followUp.status, 201);
    assert.equal(followUp.data.thread.unread_by_admin, 1);
    assert.equal(followUp.data.thread.messages.length, 3);
  });
});
