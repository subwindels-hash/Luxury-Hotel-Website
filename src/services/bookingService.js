const crypto = require('node:crypto');
const { getDb, withImmediateTransaction } = require('../db/database');
const {
  validateStayDates,
  releaseExpiredHolds,
  getHotelSettings,
  checkSingleRoomAvailability,
  calculateStayPricing,
  roundMoney,
  searchAvailability
} = require('./availabilityService');
const {
  verifyPaymentAuthorization,
  generatePaymentReference,
  generateInvoiceNumber
} = require('./paymentService');
const { sendNotification } = require('./notificationService');
const { logAudit } = require('./auditService');

function generateBookingReference() {
  const year = new Date().getUTCFullYear();
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `AUR-${year}-${rand}`;
}

/**
 * Step 5 of Booking Journey: Temporarily hold selected room inventory during checkout
 * subject to a defined expiry time.
 */
function createCheckoutHold({
  roomIds,
  checkIn,
  checkOut,
  adults = 2,
  children = 0,
  sessionId,
  userId = null,
  customHoldSeconds = null,
  ipAddress = ''
}) {
  if (!Array.isArray(roomIds) || roomIds.length === 0) {
    const err = new Error('Please select at least one physical room to hold.');
    err.code = 'NO_ROOMS_SELECTED';
    throw err;
  }

  const uniqueRoomIds = Array.from(new Set(roomIds.map((id) => Number(id))));
  validateStayDates(checkIn, checkOut);

  const db = getDb();
  const effectiveSession = sessionId || `sess_${crypto.randomBytes(8).toString('hex')}`;

  return withImmediateTransaction(db, () => {
    releaseExpiredHolds();
    const settings = getHotelSettings();

    // Release any previous active hold from the same session so switching rooms frees the prior hold
    db.prepare(`
      UPDATE room_holds
      SET status = 'RELEASED'
      WHERE session_id = ? AND status = 'ACTIVE'
    `).run(effectiveSession);

    // Check total occupancy across all selected rooms
    let totalMaxAdults = 0;
    let totalMaxOccupancy = 0;

    for (const roomId of uniqueRoomIds) {
      const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
      if (!room) {
        const err = new Error(`Selected room (ID ${roomId}) does not exist.`);
        err.code = 'ROOM_NOT_FOUND';
        throw err;
      }

      const avail = checkSingleRoomAvailability(roomId, checkIn, checkOut, effectiveSession);
      if (!avail.available) {
        const err = new Error(
          `Sorry, Room #${room.room_number} (${room.name}) has already been booked or is unavailable for part or all of your selected stay. Please choose different dates or explore other available rooms.`
        );
        err.code = 'ROOM_UNAVAILABLE';
        err.reason = avail.reason;
        err.conflictDetails = avail.conflictDetails;
        throw err;
      }

      totalMaxAdults += room.max_adults;
      totalMaxOccupancy += room.max_occupancy;
    }

    const reqAdults = Math.max(1, Number(adults) || 1);
    const reqChildren = Math.max(0, Number(children) || 0);
    if (reqAdults > totalMaxAdults || reqAdults + reqChildren > totalMaxOccupancy) {
      const err = new Error(
        `Selected room(s) accommodate up to ${totalMaxOccupancy} total guests (${totalMaxAdults} adults), which is less than your party of ${reqAdults + reqChildren}. Please add another room or choose a larger suite.`
      );
      err.code = 'CAPACITY_EXCEEDED';
      throw err;
    }

    const holdSeconds =
      customHoldSeconds !== null && customHoldSeconds !== undefined
        ? Number(customHoldSeconds)
        : (settings.hold_duration_minutes || 10) * 60;

    const expiresAtDate = new Date(Date.now() + holdSeconds * 1000);
    // Format as SQLite UTC datetime string 'YYYY-MM-DD HH:MM:SS'
    const expiresAtSqlite = expiresAtDate.toISOString().replace('T', ' ').slice(0, 19);

    const groupHoldToken = `HLD-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

    const insertHold = db.prepare(`
      INSERT INTO room_holds (
        hold_token, room_id, check_in, check_out,
        guests_adults, guests_children, session_id, user_id, status, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
    `);

    for (let i = 0; i < uniqueRoomIds.length; i++) {
      const rId = uniqueRoomIds[i];
      const tokenForRow = uniqueRoomIds.length === 1 ? groupHoldToken : `${groupHoldToken}-${i + 1}`;
      insertHold.run(
        tokenForRow,
        rId,
        checkIn,
        checkOut,
        reqAdults,
        reqChildren,
        effectiveSession,
        userId || null,
        expiresAtSqlite
      );
    }

    const pricing = calculateStayPricing({
      roomIds: uniqueRoomIds,
      checkIn,
      checkOut,
      adults: reqAdults,
      children: reqChildren
    });

    logAudit({
      eventType: 'HOLD_CREATED',
      entityType: 'room_hold',
      entityId: groupHoldToken,
      actorId: userId,
      actorRole: userId ? 'guest' : 'anonymous',
      summary: `Created checkout inventory hold ${groupHoldToken} for room(s) [${uniqueRoomIds.join(', ')}] from ${checkIn} to ${checkOut} (expires ${expiresAtSqlite} UTC).`,
      details: { groupHoldToken, roomIds: uniqueRoomIds, checkIn, checkOut, expiresAtSqlite },
      ipAddress
    });

    return {
      holdToken: groupHoldToken,
      sessionId: effectiveSession,
      roomIds: uniqueRoomIds,
      checkIn,
      checkOut,
      expiresAt: `${expiresAtSqlite}Z`,
      holdDurationSeconds: holdSeconds,
      pricing
    };
  });
}

function releaseHold(holdToken, sessionId = null) {
  if (!holdToken) return { released: 0 };
  const db = getDb();
  let sql = `
    UPDATE room_holds
    SET status = 'RELEASED'
    WHERE (hold_token = ? OR hold_token LIKE ?) AND status = 'ACTIVE'
  `;
  const params = [holdToken, `${holdToken}-%`];
  if (sessionId) {
    sql += ' AND session_id = ?';
    params.push(sessionId);
  }
  const res = db.prepare(sql).run(...params);
  return { released: res.changes };
}

/**
 * Steps 6–10 of Booking Journey:
 * Rechecks availability immediately before confirming, verifies payment result,
 * and confirms the reservation atomically inside a BEGIN IMMEDIATE transaction.
 */
function confirmReservation({
  roomIds,
  checkIn,
  checkOut,
  adults = 2,
  children = 0,
  guestFirstName,
  guestLastName,
  guestEmail,
  guestPhone,
  guestCountry = '',
  specialRequests = '',
  selectedAddons = [],
  promoCode = '',
  paymentMethod = 'card',
  paymentPlan = 'full',
  paymentToken = '',
  cardBrand = '',
  cardLast4 = '',
  bankReference = '',
  currency = 'USD',
  holdToken = '',
  sessionId = '',
  userId = null,
  bookingSource = 'online',
  bookedByStaffId = null,
  ipAddress = ''
}) {
  if (!guestFirstName || !guestLastName || !guestEmail || !guestPhone) {
    const err = new Error('Guest first name, last name, email address, and phone number are required.');
    err.code = 'MISSING_GUEST_DETAILS';
    throw err;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(guestEmail).trim())) {
    const err = new Error('Please provide a valid guest email address.');
    err.code = 'INVALID_EMAIL';
    throw err;
  }

  if (!Array.isArray(roomIds) || roomIds.length === 0) {
    const err = new Error('At least one physical room must be selected for reservation.');
    err.code = 'NO_ROOMS_SELECTED';
    throw err;
  }

  const uniqueRoomIds = Array.from(new Set(roomIds.map((id) => Number(id))));
  validateStayDates(checkIn, checkOut);

  const db = getDb();

  // Execute the entire revalidation + payment verification + reservation insert inside an atomic BEGIN IMMEDIATE transaction
  const confirmedData = withImmediateTransaction(db, () => {
    releaseExpiredHolds();
    const settings = getHotelSettings();

    // If a holdToken was provided, check if it expired while the guest was on the checkout screen
    if (holdToken) {
      const holdRows = db.prepare(`
        SELECT * FROM room_holds
        WHERE hold_token = ? OR hold_token LIKE ?
      `).all(holdToken, `${holdToken}-%`);

      const expiredHold = holdRows.find((h) => h.status === 'EXPIRED');
      if (expiredHold) {
        // Hold expired; check if another guest took the room in the meantime!
        for (const rId of uniqueRoomIds) {
          const checkNow = checkSingleRoomAvailability(rId, checkIn, checkOut, sessionId, holdToken);
          if (!checkNow.available) {
            const altSearch = searchAvailability({ checkIn, checkOut, adults, children, roomsRequired: uniqueRoomIds.length, currency });
            const err = new Error(
              'Your checkout hold expired and another guest has just reserved this room for your selected dates. Please choose another available room or select different dates.'
            );
            err.code = 'AVAILABILITY_CHANGED_DURING_CHECKOUT';
            err.alternativeRooms = altSearch.availableRooms.slice(0, 3);
            throw err;
          }
        }
      }
    }

    // Immediate pre-confirmation revalidation of every selected physical room
    let totalMaxAdults = 0;
    let totalMaxOccupancy = 0;
    for (const rId of uniqueRoomIds) {
      const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(rId);
      if (!room) {
        const err = new Error(`Selected room ID ${rId} was not found.`);
        err.code = 'ROOM_NOT_FOUND';
        throw err;
      }

      const avail = checkSingleRoomAvailability(rId, checkIn, checkOut, sessionId, holdToken);
      if (!avail.available) {
        const altSearch = searchAvailability({ checkIn, checkOut, adults, children, roomsRequired: uniqueRoomIds.length, currency });
        const err = new Error(
          `Availability changed during checkout: Room #${room.room_number} (${room.name}) has just been booked or blocked by another guest. No charge was made. Please select an alternative room or date.`
        );
        err.code = 'AVAILABILITY_CHANGED_DURING_CHECKOUT';
        err.reason = avail.reason;
        err.alternativeRooms = altSearch.availableRooms.slice(0, 3);
        throw err;
      }

      totalMaxAdults += room.max_adults;
      totalMaxOccupancy += room.max_occupancy;
    }

    const reqAdults = Math.max(1, Number(adults) || 1);
    const reqChildren = Math.max(0, Number(children) || 0);
    if (reqAdults > totalMaxAdults || reqAdults + reqChildren > totalMaxOccupancy) {
      const err = new Error('Guest count exceeds the maximum permitted occupancy of the selected room(s).');
      err.code = 'CAPACITY_EXCEEDED';
      throw err;
    }

    // Recalculate authoritative server-side pricing
    const pricing = calculateStayPricing({
      roomIds: uniqueRoomIds,
      checkIn,
      checkOut,
      adults: reqAdults,
      children: reqChildren,
      selectedAddons,
      promoCode,
      paymentPlan,
      currency
    });

    // Verify payment authorization BEFORE writing reservation
    const paymentVerification = verifyPaymentAuthorization({
      paymentMethod,
      paymentPlan,
      amountDueNow: pricing.amountDueNow,
      totalAmount: pricing.totalAmount,
      currency: pricing.displayCurrency,
      exchangeRate: pricing.exchangeRate,
      paymentToken,
      cardBrand,
      cardLast4,
      bankReference,
      allowPayAtHotel: Boolean(settings.allow_pay_at_hotel)
    });

    // Generate unique booking reference
    let bookingReference = generateBookingReference();
    while (db.prepare('SELECT id FROM reservations WHERE booking_reference = ?').get(bookingReference)) {
      bookingReference = generateBookingReference();
    }

    // Insert reservation record
    const insertRes = db.prepare(`
      INSERT INTO reservations (
        booking_reference, user_id, guest_first_name, guest_last_name,
        guest_email, guest_phone, guest_country, special_requests,
        check_in, check_out, nights, adults, children, rooms_count,
        status, payment_status, payment_method, payment_plan,
        currency, exchange_rate, room_subtotal, seasonal_adjustment,
        extras_subtotal, discount_amount, promo_code,
        tax_amount, service_fee_amount, city_levy_amount,
        total_amount, amount_due_now, amount_paid, refunded_amount,
        hold_token, booking_source, booked_by_staff_id
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, 0, ?, ?, ?
      )
    `);

    const resResult = insertRes.run(
      bookingReference,
      userId || null,
      String(guestFirstName).trim(),
      String(guestLastName).trim(),
      String(guestEmail).trim().toLowerCase(),
      String(guestPhone).trim(),
      String(guestCountry || '').trim(),
      String(specialRequests || '').trim(),
      checkIn,
      checkOut,
      pricing.nights,
      reqAdults,
      reqChildren,
      uniqueRoomIds.length,
      paymentVerification.reservationPaymentStatus,
      paymentMethod,
      paymentPlan,
      pricing.displayCurrency,
      pricing.exchangeRate,
      pricing.roomSubtotal,
      pricing.seasonalAdjustment,
      pricing.extrasSubtotal,
      pricing.discountAmount,
      pricing.appliedPromo ? pricing.appliedPromo.code : '',
      pricing.taxAmount,
      pricing.serviceFeeAmount,
      pricing.cityLevyAmount,
      pricing.totalAmount,
      pricing.amountDueNow,
      paymentVerification.amountPaid,
      holdToken || '',
      bookingSource,
      bookedByStaffId || null
    );

    const reservationId = Number(resResult.lastInsertRowid);

    // Insert reservation_rooms rows (triggers trg_prevent_double_booking_insert at DB level!)
    const insertResRoom = db.prepare(`
      INSERT INTO reservation_rooms (
        reservation_id, room_id, room_number, room_name, category_name,
        check_in, check_out, nightly_rate, nights, room_total, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `);

    for (const rb of pricing.roomBreakdowns) {
      insertResRoom.run(
        reservationId,
        rb.roomId,
        rb.roomNumber,
        rb.roomName,
        rb.categoryName,
        checkIn,
        checkOut,
        rb.effectiveNightlyRate,
        rb.nights,
        rb.roomTotal
      );
    }

    // Insert reservation_addons rows
    if (pricing.addonBreakdowns.length > 0) {
      const insertResAddon = db.prepare(`
        INSERT INTO reservation_addons (
          reservation_id, addon_id, addon_code, addon_name, unit_price, quantity, total_price
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const ab of pricing.addonBreakdowns) {
        insertResAddon.run(
          reservationId,
          ab.addonId,
          ab.code,
          ab.name,
          ab.unitPrice,
          ab.quantity,
          ab.totalPrice
        );
      }
    }

    // Increment promo code usage if applied
    if (pricing.appliedPromo) {
      db.prepare('UPDATE promo_codes SET current_uses = current_uses + 1 WHERE code = ?').run(pricing.appliedPromo.code);
    }

    // Convert any active checkout hold to CONVERTED
    if (holdToken || sessionId) {
      db.prepare(`
        UPDATE room_holds
        SET status = 'CONVERTED'
        WHERE status = 'ACTIVE' AND (hold_token = ? OR hold_token LIKE ? OR session_id = ?)
      `).run(holdToken || '__none__', `${holdToken || '__none__'}-%`, sessionId || '__none__');
    }

    // Insert payment record
    db.prepare(`
      INSERT INTO payments (
        payment_reference, invoice_number, reservation_id, booking_reference,
        amount, currency, display_currency, display_amount,
        payment_method, payment_type, token_id, card_brand, card_last4,
        bank_reference, status, gateway_response_json, verified_at
      ) VALUES (?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      paymentVerification.paymentReference,
      paymentVerification.invoiceNumber,
      reservationId,
      bookingReference,
      paymentVerification.amountPaid,
      paymentVerification.displayCurrency,
      paymentVerification.displayAmount,
      paymentVerification.paymentMethod,
      paymentVerification.paymentType,
      paymentVerification.tokenId,
      paymentVerification.cardBrand,
      paymentVerification.cardLast4,
      paymentVerification.bankReference,
      paymentVerification.paymentRecordStatus,
      JSON.stringify({
        verified: true,
        plan: paymentPlan,
        totalStayUsd: pricing.totalAmount,
        amountDueNowUsd: pricing.amountDueNow
      }),
      paymentVerification.verifiedAt
    );

    // Award loyalty points if booked by a registered user
    if (userId) {
      const pointsEarned = Math.round(pricing.totalAmount * 2);
      db.prepare('UPDATE users SET loyalty_points = loyalty_points + ? WHERE id = ?').run(pointsEarned, userId);
    }

    logAudit({
      eventType: 'RESERVATION_CONFIRMED',
      entityType: 'reservation',
      entityId: bookingReference,
      actorId: bookedByStaffId || userId,
      actorRole: bookedByStaffId ? 'staff' : 'guest',
      actorEmail: guestEmail,
      summary: `Confirmed reservation ${bookingReference} for ${guestFirstName} ${guestLastName} (${checkIn} to ${checkOut}), rooms: [${pricing.roomBreakdowns.map((r) => `#${r.roomNumber}`).join(', ')}], total: $${pricing.totalAmount.toFixed(2)}.`,
      details: {
        bookingReference,
        reservationId,
        roomIds: uniqueRoomIds,
        checkIn,
        checkOut,
        totalAmount: pricing.totalAmount,
        paymentReference: paymentVerification.paymentReference,
        paymentStatus: paymentVerification.reservationPaymentStatus
      },
      ipAddress
    });

    return {
      reservationId,
      bookingReference,
      pricing,
      paymentVerification
    };
  });

  // Send confirmation & payment notifications
  const roomSummary = confirmedData.pricing.roomBreakdowns
    .map((r) => `${r.roomName} (#${r.roomNumber})`)
    .join(', ');

  sendNotification({
    templateCode: 'BOOKING_CONFIRMED',
    reservationId: confirmedData.reservationId,
    userId,
    recipientEmail: guestEmail,
    recipientPhone: guestPhone,
    variables: {
      guest_name: `${guestFirstName} ${guestLastName}`,
      booking_reference: confirmedData.bookingReference,
      room_summary: roomSummary,
      check_in: checkIn,
      check_out: checkOut,
      total_formatted: `${confirmedData.pricing.currencySymbol}${confirmedData.pricing.convertedTotalAmount.toLocaleString()} (${confirmedData.pricing.displayCurrency})`,
      payment_status: confirmedData.paymentVerification.reservationPaymentStatus.toUpperCase()
    }
  });

  if (confirmedData.paymentVerification.amountPaid > 0) {
    sendNotification({
      templateCode: 'PAYMENT_RECEIPT',
      reservationId: confirmedData.reservationId,
      userId,
      recipientEmail: guestEmail,
      recipientPhone: guestPhone,
      variables: {
        guest_name: `${guestFirstName} ${guestLastName}`,
        booking_reference: confirmedData.bookingReference,
        invoice_number: confirmedData.paymentVerification.invoiceNumber,
        payment_reference: confirmedData.paymentVerification.paymentReference,
        amount_formatted: `$${confirmedData.paymentVerification.amountPaid.toFixed(2)} USD`,
        payment_method: paymentMethod.toUpperCase()
      }
    });
  }

  return getReservationByReference(confirmedData.bookingReference);
}

function getReservationByReference(bookingReference) {
  const db = getDb();
  const res = db.prepare('SELECT * FROM reservations WHERE UPPER(booking_reference) = UPPER(?)').get(String(bookingReference || '').trim());
  if (!res) return null;

  const rooms = db.prepare(`
    SELECT rr.*, r.hero_image, r.floor, r.wing, r.view_type, r.bed_type, r.size_sqm, r.housekeeping_status
    FROM reservation_rooms rr
    LEFT JOIN rooms r ON r.id = rr.room_id
    WHERE rr.reservation_id = ?
  `).all(res.id);

  const addons = db.prepare('SELECT * FROM reservation_addons WHERE reservation_id = ?').all(res.id);
  const payments = db.prepare('SELECT * FROM payments WHERE reservation_id = ? ORDER BY id ASC').all(res.id);
  const notifications = db.prepare('SELECT * FROM notifications WHERE reservation_id = ? ORDER BY id DESC').all(res.id);
  const folioCharges = db.prepare('SELECT * FROM folio_charges WHERE reservation_id = ? ORDER BY id ASC').all(res.id);

  let dossier = db.prepare('SELECT * FROM pre_arrival_dossiers WHERE reservation_id = ?').get(res.id);
  if (!dossier) {
    dossier = {
      reservation_id: res.id,
      booking_reference: res.booking_reference,
      pillow_preference: 'Quagliotti Goose Down (Medium-Plush)',
      suite_temperature_c: 21.0,
      turndown_scent: 'Grasse Jasmine & White Neroli',
      arrival_transport_mode: 'Rolls-Royce Chauffeur Pickup',
      flight_or_tail_number: '',
      estimated_arrival_time: '15:00',
      dietary_allergies: 'None',
      butler_notes: res.special_requests || '',
      digital_key_code: `KEY-${res.booking_reference}-VIP`
    };
  }

  const guestReview = db.prepare('SELECT * FROM guest_reviews WHERE reservation_id = ?').get(res.id) || null;
  const facilityBookings = db.prepare(
    "SELECT * FROM facility_bookings WHERE reservation_id = ? AND status = 'confirmed' ORDER BY reservation_date ASC, slot_time ASC"
  ).all(res.id);
  const incidentalTotal = roundMoney(folioCharges.reduce((sum, c) => sum + Number(c.total_amount || 0), 0));
  const grandFolioTotal = roundMoney(Number(res.total_amount || 0) + incidentalTotal);
  const remainingFolioBalance = roundMoney(Math.max(0, grandFolioTotal - Number(res.amount_paid || 0)));

  return {
    ...res,
    rooms,
    addons,
    payments,
    notifications,
    folioCharges,
    facilityBookings,
    incidentalTotal,
    grandFolioTotal,
    remainingFolioBalance,
    preArrivalDossier: dossier,
    guestReview
  };
}

/**
 * Cancels a reservation, releases the physical room inventory immediately,
 * calculates policy-based or staff-authorised refund, and records audit + notification.
 */
function cancelReservation({
  bookingReference,
  reason = 'Guest requested cancellation',
  actorId = null,
  actorRole = 'guest',
  actorEmail = '',
  forceFullRefund = false,
  ipAddress = ''
}) {
  const db = getDb();
  const existing = getReservationByReference(bookingReference);
  if (!existing) {
    const err = new Error('Reservation not found.');
    err.code = 'RESERVATION_NOT_FOUND';
    throw err;
  }

  if (existing.status === 'cancelled') {
    const err = new Error('This reservation has already been cancelled.');
    err.code = 'ALREADY_CANCELLED';
    throw err;
  }

  if (existing.status === 'checked_out') {
    const err = new Error('Completed stays that have already checked out cannot be cancelled.');
    err.code = 'CANNOT_CANCEL_CHECKED_OUT';
    throw err;
  }

  const settings = getHotelSettings();

  return withImmediateTransaction(db, () => {
    // Calculate refund amount based on hotel cancellation policy
    const checkInTimestamp = new Date(`${existing.check_in}T${settings.check_in_time || '15:00'}:00Z`).getTime();
    const hoursUntilCheckIn = (checkInTimestamp - Date.now()) / (1000 * 60 * 60);
    const freeCancelHours = settings.free_cancellation_hours || 48;
    const penaltyPercent = settings.late_cancellation_penalty_percent || 50;

    let refundAmount = 0;
    let penaltyApplied = false;

    if (existing.amount_paid > 0) {
      if (forceFullRefund || hoursUntilCheckIn >= freeCancelHours) {
        refundAmount = roundMoney(existing.amount_paid);
      } else {
        const penaltyAmount = roundMoney(existing.total_amount * (penaltyPercent / 100));
        refundAmount = Math.max(0, roundMoney(existing.amount_paid - penaltyAmount));
        penaltyApplied = true;
      }
    }

    const newPaymentStatus =
      existing.amount_paid === 0
        ? existing.payment_status
        : refundAmount >= existing.amount_paid
        ? 'refunded'
        : refundAmount > 0
        ? 'partially_refunded'
        : existing.payment_status;

    // 1. Update reservation status
    db.prepare(`
      UPDATE reservations
      SET status = 'cancelled',
          payment_status = ?,
          refunded_amount = ?,
          cancelled_at = datetime('now'),
          cancellation_reason = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(newPaymentStatus, refundAmount, reason, existing.id);

    // 2. Release physical rooms in reservation_rooms so they become immediately bookable again
    db.prepare(`
      UPDATE reservation_rooms
      SET status = 'cancelled'
      WHERE reservation_id = ?
    `).run(existing.id);

    // 3. Record refund payment transaction if refundAmount > 0
    let refundPaymentRef = null;
    if (refundAmount > 0) {
      refundPaymentRef = generatePaymentReference('RFD');
      db.prepare(`
        INSERT INTO payments (
          payment_reference, invoice_number, reservation_id, booking_reference,
          amount, currency, display_currency, display_amount,
          payment_method, payment_type, status, gateway_response_json, verified_at
        ) VALUES (?, ?, ?, ?, ?, 'USD', ?, ?, ?, 'refund', 'refunded', ?, datetime('now'))
      `).run(
        refundPaymentRef,
        generateInvoiceNumber(),
        existing.id,
        existing.booking_reference,
        -refundAmount,
        existing.currency,
        roundMoney(-refundAmount * existing.exchange_rate),
        existing.payment_method,
        JSON.stringify({
          refundAmount,
          penaltyApplied,
          hoursUntilCheckIn: Math.round(hoursUntilCheckIn),
          reason
        })
      );
    }

    logAudit({
      eventType: 'RESERVATION_CANCELLED',
      entityType: 'reservation',
      entityId: existing.booking_reference,
      actorId,
      actorRole,
      actorEmail,
      summary: `Cancelled reservation ${existing.booking_reference}. Released room inventory. Refund issued: $${refundAmount.toFixed(2)} USD.`,
      details: {
        bookingReference: existing.booking_reference,
        reason,
        refundAmount,
        penaltyApplied,
        refundPaymentRef
      },
      ipAddress
    });

    sendNotification({
      templateCode: 'BOOKING_CANCELLED',
      reservationId: existing.id,
      userId: existing.user_id,
      recipientEmail: existing.guest_email,
      recipientPhone: existing.guest_phone,
      variables: {
        guest_name: `${existing.guest_first_name} ${existing.guest_last_name}`,
        booking_reference: existing.booking_reference,
        check_in: existing.check_in,
        check_out: existing.check_out,
        refund_formatted: `$${refundAmount.toFixed(2)} USD`,
        cancellation_reason: reason
      }
    });

    return {
      cancelled: true,
      bookingReference: existing.booking_reference,
      refundAmount,
      penaltyApplied,
      refundPaymentRef,
      reservation: getReservationByReference(existing.booking_reference)
    };
  });
}

/**
 * Modifies a reservation's check-in / check-out dates if permitted by policy and
 * if the reserved physical room(s) are available for the new date range.
 */
function modifyReservationDates({
  bookingReference,
  newCheckIn,
  newCheckOut,
  actorId = null,
  actorRole = 'guest',
  actorEmail = '',
  ipAddress = ''
}) {
  validateStayDates(newCheckIn, newCheckOut);
  const existing = getReservationByReference(bookingReference);
  if (!existing) {
    const err = new Error('Reservation not found.');
    err.code = 'RESERVATION_NOT_FOUND';
    throw err;
  }

  if (existing.status !== 'confirmed') {
    const err = new Error(`Only confirmed upcoming reservations can have their dates modified (current status: ${existing.status}).`);
    err.code = 'MODIFICATION_NOT_PERMITTED';
    throw err;
  }

  const db = getDb();

  return withImmediateTransaction(db, () => {
    releaseExpiredHolds();

    const roomIds = (existing.rooms || []).map((r) => r.room_id);
    const addonCodes = (existing.addons || []).map((a) => ({
      code: a.addon_code,
      quantity: a.quantity
    }));

    // Update each reservation_rooms row (trg_prevent_double_booking_update verifies no other active booking or maintenance block overlaps!)
    const pricing = calculateStayPricing({
      roomIds,
      checkIn: newCheckIn,
      checkOut: newCheckOut,
      adults: existing.adults,
      children: existing.children,
      selectedAddons: addonCodes,
      promoCode: existing.promo_code || '',
      paymentPlan: existing.payment_plan,
      currency: existing.currency
    });

    const updateRoomStmt = db.prepare(`
      UPDATE reservation_rooms
      SET check_in = ?, check_out = ?, nightly_rate = ?, nights = ?, room_total = ?
      WHERE reservation_id = ? AND room_id = ?
    `);

    for (const rb of pricing.roomBreakdowns) {
      updateRoomStmt.run(
        newCheckIn,
        newCheckOut,
        rb.effectiveNightlyRate,
        rb.nights,
        rb.roomTotal,
        existing.id,
        rb.roomId
      );
    }

    const newPaymentStatus =
      existing.amount_paid >= pricing.totalAmount
        ? 'paid'
        : existing.amount_paid > 0
        ? 'deposit_paid'
        : existing.payment_status;

    db.prepare(`
      UPDATE reservations
      SET check_in = ?,
          check_out = ?,
          nights = ?,
          room_subtotal = ?,
          seasonal_adjustment = ?,
          extras_subtotal = ?,
          discount_amount = ?,
          tax_amount = ?,
          service_fee_amount = ?,
          city_levy_amount = ?,
          total_amount = ?,
          payment_status = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      newCheckIn,
      newCheckOut,
      pricing.nights,
      pricing.roomSubtotal,
      pricing.seasonalAdjustment,
      pricing.extrasSubtotal,
      pricing.discountAmount,
      pricing.taxAmount,
      pricing.serviceFeeAmount,
      pricing.cityLevyAmount,
      pricing.totalAmount,
      newPaymentStatus,
      existing.id
    );

    logAudit({
      eventType: 'RESERVATION_DATES_MODIFIED',
      entityType: 'reservation',
      entityId: existing.booking_reference,
      actorId,
      actorRole,
      actorEmail,
      summary: `Modified reservation ${existing.booking_reference} dates from (${existing.check_in} -> ${existing.check_out}) to (${newCheckIn} -> ${newCheckOut}). New total: $${pricing.totalAmount.toFixed(2)}.`,
      details: {
        oldCheckIn: existing.check_in,
        oldCheckOut: existing.check_out,
        newCheckIn,
        newCheckOut,
        newTotalAmount: pricing.totalAmount
      },
      ipAddress
    });

    return {
      modified: true,
      reservation: getReservationByReference(existing.booking_reference)
    };
  });
}

function savePreArrivalDossier({
  bookingReference,
  pillowPreference = 'Quagliotti Goose Down (Medium-Plush)',
  suiteTemperatureC = 21.0,
  turndownScent = 'Grasse Jasmine & White Neroli',
  arrivalTransportMode = 'Rolls-Royce Chauffeur Pickup',
  flightOrTailNumber = '',
  estimatedArrivalTime = '15:00',
  dietaryAllergies = 'None',
  butlerNotes = '',
  actorEmail = '',
  ipAddress = ''
}) {
  const existing = getReservationByReference(bookingReference);
  if (!existing) {
    const err = new Error('Reservation not found.');
    err.code = 'RESERVATION_NOT_FOUND';
    throw err;
  }

  const db = getDb();
  const keyCode = `KEY-${existing.booking_reference}-${crypto.createHash('sha1').update(existing.booking_reference).digest('hex').slice(0, 4).toUpperCase()}`;

  db.prepare(`
    INSERT INTO pre_arrival_dossiers (
      reservation_id, booking_reference, pillow_preference, suite_temperature_c,
      turndown_scent, arrival_transport_mode, flight_or_tail_number,
      estimated_arrival_time, dietary_allergies, butler_notes, digital_key_code, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(reservation_id) DO UPDATE SET
      pillow_preference = excluded.pillow_preference,
      suite_temperature_c = excluded.suite_temperature_c,
      turndown_scent = excluded.turndown_scent,
      arrival_transport_mode = excluded.arrival_transport_mode,
      flight_or_tail_number = excluded.flight_or_tail_number,
      estimated_arrival_time = excluded.estimated_arrival_time,
      dietary_allergies = excluded.dietary_allergies,
      butler_notes = excluded.butler_notes,
      updated_at = datetime('now')
  `).run(
    existing.id,
    existing.booking_reference,
    pillowPreference,
    Number(suiteTemperatureC || 21.0),
    turndownScent,
    arrivalTransportMode,
    flightOrTailNumber,
    estimatedArrivalTime,
    dietaryAllergies,
    butlerNotes,
    keyCode
  );

  if (butlerNotes) {
    db.prepare("UPDATE reservations SET special_requests = ?, updated_at = datetime('now') WHERE id = ?").run(butlerNotes, existing.id);
  }

  logAudit({
    eventType: 'PRE_ARRIVAL_DOSSIER_SAVED',
    entityType: 'reservation',
    entityId: existing.booking_reference,
    actorRole: 'guest',
    actorEmail: actorEmail || existing.guest_email,
    summary: `Updated Digital Pre-Arrival Butler Dossier for ${existing.booking_reference} (Pillow: ${pillowPreference}, Temp: ${suiteTemperatureC}°C, Transport: ${arrivalTransportMode}).`,
    details: { pillowPreference, suiteTemperatureC, turndownScent, arrivalTransportMode, flightOrTailNumber, estimatedArrivalTime },
    ipAddress
  });

  return getReservationByReference(existing.booking_reference);
}

function addFolioCharge({
  bookingReference,
  category = 'In-Suite Dining',
  description,
  unitPrice,
  quantity = 1,
  postedBy = 'Front Desk / Concierge',
  actorId = null,
  actorRole = 'staff',
  actorEmail = '',
  ipAddress = ''
}) {
  const existing = getReservationByReference(bookingReference);
  if (!existing) {
    const err = new Error('Reservation not found.');
    err.code = 'RESERVATION_NOT_FOUND';
    throw err;
  }
  if (!description || Number(unitPrice) <= 0) {
    const err = new Error('Valid description and positive unitPrice are required for folio charges.');
    err.code = 'INVALID_FOLIO_CHARGE';
    throw err;
  }

  const qty = Math.max(1, Number(quantity) || 1);
  const uPrice = roundMoney(Number(unitPrice));
  const totalAmount = roundMoney(uPrice * qty);

  const db = getDb();
  const res = db.prepare(`
    INSERT INTO folio_charges (
      reservation_id, booking_reference, category, description, unit_price, quantity, total_amount, posted_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(existing.id, existing.booking_reference, category, description, uPrice, qty, totalAmount, postedBy);

  logAudit({
    eventType: 'FOLIO_CHARGE_POSTED',
    entityType: 'reservation',
    entityId: existing.booking_reference,
    actorId,
    actorRole,
    actorEmail,
    summary: `Posted incidental folio charge to ${existing.booking_reference}: ${description} (${qty} × $${uPrice.toFixed(2)} = $${totalAmount.toFixed(2)}).`,
    details: { chargeId: Number(res.lastInsertRowid), category, description, unitPrice: uPrice, quantity: qty, totalAmount },
    ipAddress
  });

  return getReservationByReference(existing.booking_reference);
}

function removeFolioCharge({
  bookingReference,
  chargeId,
  actorId = null,
  actorRole = 'staff',
  actorEmail = '',
  ipAddress = ''
}) {
  const existing = getReservationByReference(bookingReference);
  if (!existing) {
    const err = new Error('Reservation not found.');
    err.code = 'RESERVATION_NOT_FOUND';
    throw err;
  }

  const db = getDb();
  db.prepare('DELETE FROM folio_charges WHERE id = ? AND reservation_id = ?').run(Number(chargeId), existing.id);

  logAudit({
    eventType: 'FOLIO_CHARGE_VOIDED',
    entityType: 'reservation',
    entityId: existing.booking_reference,
    actorId,
    actorRole,
    actorEmail,
    summary: `Voided incidental folio charge #${chargeId} on reservation ${existing.booking_reference}.`,
    ipAddress
  });

  return getReservationByReference(existing.booking_reference);
}

function submitGuestReview({
  bookingReference,
  rating = 5,
  title,
  comment,
  ipAddress = ''
}) {
  const existing = getReservationByReference(bookingReference);
  if (!existing) {
    const err = new Error('Reservation not found.');
    err.code = 'RESERVATION_NOT_FOUND';
    throw err;
  }
  if (existing.status === 'cancelled') {
    const err = new Error('Cancelled reservations cannot submit a verified stay review.');
    err.code = 'REVIEW_NOT_ELIGIBLE';
    throw err;
  }
  if (!title || !comment) {
    const err = new Error('Review title and comment are required.');
    err.code = 'MISSING_REVIEW_FIELDS';
    throw err;
  }

  const firstRoom = (existing.rooms && existing.rooms[0]) || {};
  const numRating = Math.min(5, Math.max(1, Math.round(Number(rating) || 5)));
  const db = getDb();

  db.prepare(`
    INSERT INTO guest_reviews (
      reservation_id, booking_reference, room_id, room_number, guest_name, rating, title, comment
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(reservation_id) DO UPDATE SET
      rating = excluded.rating,
      title = excluded.title,
      comment = excluded.comment
  `).run(
    existing.id,
    existing.booking_reference,
    firstRoom.room_id || null,
    firstRoom.room_number || 'Suite',
    `${existing.guest_first_name} ${existing.guest_last_name.charAt(0)}.`,
    numRating,
    title,
    comment
  );

  logAudit({
    eventType: 'GUEST_REVIEW_SUBMITTED',
    entityType: 'reservation',
    entityId: existing.booking_reference,
    actorRole: 'guest',
    actorEmail: existing.guest_email,
    summary: `Verified guest review (${numRating}/5 stars) submitted for ${existing.booking_reference} (Room #${firstRoom.room_number || 'Suite'}).`,
    ipAddress
  });

  return getReservationByReference(existing.booking_reference);
}

const FACILITY_NAMES = {
  michelin_dining: 'Le Jardin d’Or (Three-Michelin-Starred Restaurant)',
  thermal_spa: 'Travertine Thermal Sanctuary & Spa',
  private_cinema: 'Aurélia Private Velvet Cinema',
  yacht_charter: 'Lakefront Private Riva Yacht Pier'
};

/**
 * DiningAndSpaSlotBookingModule:
 * Books a specific time-slot at Le Jardin d'Or or the Travertine Thermal Sanctuary,
 * prevents overlapping duplicate slot bookings, and links charges to the guest folio.
 */
function bookFacilitySlot({
  bookingReference,
  facilityType = 'michelin_dining',
  reservationDate,
  slotTime = '19:30',
  guestsCount = 2,
  treatmentOrMenu = 'Seven-Course Chef Tasting Table',
  price = 0,
  actorEmail = '',
  ipAddress = ''
}) {
  const existing = getReservationByReference(bookingReference);
  if (!existing) {
    const err = new Error('Reservation not found.');
    err.code = 'RESERVATION_NOT_FOUND';
    throw err;
  }
  if (existing.status === 'cancelled') {
    const err = new Error('Cannot book dining or spa slots for a cancelled reservation.');
    err.code = 'RESERVATION_CANCELLED';
    throw err;
  }

  const targetDate = reservationDate || existing.check_in;
  const db = getDb();

  return withImmediateTransaction(db, () => {
    const duplicateSlot = db.prepare(`
      SELECT id FROM facility_bookings
      WHERE reservation_id = ? AND facility_type = ? AND reservation_date = ? AND slot_time = ? AND status = 'confirmed'
    `).get(existing.id, facilityType, targetDate, slotTime);

    if (duplicateSlot) {
      const err = new Error(`You already have a confirmed ${FACILITY_NAMES[facilityType] || facilityType} slot on ${targetDate} at ${slotTime}.`);
      err.code = 'FACILITY_SLOT_ALREADY_BOOKED';
      throw err;
    }

    const numPrice = roundMoney(Math.max(0, Number(price || 0)));
    const numGuests = Math.max(1, Number(guestsCount || 2));
    const facilityName = FACILITY_NAMES[facilityType] || 'Hotel Sanctuary Facility';

    let folioChargeId = null;
    if (numPrice > 0) {
      const folioCategory = facilityType === 'michelin_dining' ? 'Le Jardin d’Or Restaurant' : 'Thermal Spa & Wellness';
      const fRes = db.prepare(`
        INSERT INTO folio_charges (
          reservation_id, booking_reference, category, description, unit_price, quantity, total_amount, posted_by
        ) VALUES (?, ?, ?, ?, ?, 1, ?, 'Online Concierge Slot Booking')
      `).run(
        existing.id,
        existing.booking_reference,
        folioCategory,
        `${treatmentOrMenu} (${targetDate} @ ${slotTime}, ${numGuests} guests)`,
        numPrice,
        numPrice
      );
      folioChargeId = Number(fRes.lastInsertRowid);
    }

    const slotRes = db.prepare(`
      INSERT INTO facility_bookings (
        reservation_id, booking_reference, facility_type, facility_name,
        reservation_date, slot_time, guests_count, treatment_or_menu,
        price, folio_charge_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')
    `).run(
      existing.id,
      existing.booking_reference,
      facilityType,
      facilityName,
      targetDate,
      slotTime,
      numGuests,
      treatmentOrMenu,
      numPrice,
      folioChargeId
    );

    logAudit({
      eventType: 'FACILITY_SLOT_BOOKED',
      entityType: 'reservation',
      entityId: existing.booking_reference,
      actorRole: 'guest',
      actorEmail: actorEmail || existing.guest_email,
      summary: `Booked ${facilityName} slot (${treatmentOrMenu}) for ${existing.booking_reference} on ${targetDate} at ${slotTime} ($${numPrice.toFixed(2)}).`,
      details: { slotId: Number(slotRes.lastInsertRowid), facilityType, targetDate, slotTime, treatmentOrMenu, price: numPrice },
      ipAddress
    });

    return getReservationByReference(existing.booking_reference);
  });
}

function cancelFacilitySlot({
  bookingReference,
  slotId,
  actorEmail = '',
  ipAddress = ''
}) {
  const existing = getReservationByReference(bookingReference);
  if (!existing) {
    const err = new Error('Reservation not found.');
    err.code = 'RESERVATION_NOT_FOUND';
    throw err;
  }

  const db = getDb();
  return withImmediateTransaction(db, () => {
    const slot = db.prepare('SELECT * FROM facility_bookings WHERE id = ? AND reservation_id = ?').get(Number(slotId), existing.id);
    if (!slot) {
      const err = new Error('Facility booking slot not found.');
      err.code = 'SLOT_NOT_FOUND';
      throw err;
    }

    db.prepare("UPDATE facility_bookings SET status = 'cancelled' WHERE id = ?").run(slot.id);
    if (slot.folio_charge_id) {
      db.prepare('DELETE FROM folio_charges WHERE id = ?').run(slot.folio_charge_id);
    }

    logAudit({
      eventType: 'FACILITY_SLOT_CANCELLED',
      entityType: 'reservation',
      entityId: existing.booking_reference,
      actorRole: 'guest',
      actorEmail: actorEmail || existing.guest_email,
      summary: `Cancelled facility slot #${slot.id} (${slot.treatment_or_menu} on ${slot.reservation_date} @ ${slot.slot_time}) for ${existing.booking_reference}.`,
      ipAddress
    });

    return getReservationByReference(existing.booking_reference);
  });
}

module.exports = {
  generateBookingReference,
  createCheckoutHold,
  releaseHold,
  confirmReservation,
  getReservationByReference,
  cancelReservation,
  modifyReservationDates,
  savePreArrivalDossier,
  addFolioCharge,
  removeFolioCharge,
  submitGuestReview,
  bookFacilitySlot,
  cancelFacilitySlot
};
