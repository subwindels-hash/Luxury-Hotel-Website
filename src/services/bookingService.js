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
const { broadcastFrontDeskEvent } = require('./sseService');

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
  redeemLoyaltyPoints = false,
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
      redeemLoyaltyPoints: Boolean(redeemLoyaltyPoints),
      userId,
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
        loyalty_points_redeemed, loyalty_discount_amount,
        tax_amount, service_fee_amount, city_levy_amount,
        total_amount, amount_due_now, amount_paid, refunded_amount,
        hold_token, booking_source, booked_by_staff_id
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?,
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
      pricing.loyaltyPointsRedeemed || 0,
      pricing.loyaltyDiscountAmount || 0,
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

    // Deduct redeemed loyalty points & award new loyalty points if booked by a registered user
    if (userId) {
      const redeemed = Number(pricing.loyaltyPointsRedeemed || 0);
      const pointsEarned = Math.round(pricing.totalAmount * 2);
      db.prepare('UPDATE users SET loyalty_points = MAX(0, loyalty_points - ?) + ? WHERE id = ?').run(redeemed, pointsEarned, userId);
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

  broadcastFrontDeskEvent({
    type: 'RESERVATION_CREATED',
    title: `New Reservation ${confirmedData.bookingReference}`,
    message: `${guestFirstName} ${guestLastName} reserved ${roomSummary} (${checkIn} to ${checkOut})`,
    bookingReference: confirmedData.bookingReference
  });

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

    // Refund redeemed loyalty points if any
    if (existing.user_id && Number(existing.loyalty_points_redeemed || 0) > 0) {
      db.prepare('UPDATE users SET loyalty_points = loyalty_points + ? WHERE id = ?').run(
        Number(existing.loyalty_points_redeemed),
        existing.user_id
      );
    }

    // Automatically notify any priority waitlist guests waiting for the released physical room(s)
    const releasedRoomIds = (existing.rooms || []).map((r) => r.room_id).filter(Boolean);
    const notifiedWaitlist = notifyMatchingWaitlistEntries({
      roomIds: releasedRoomIds,
      checkIn: existing.check_in,
      checkOut: existing.check_out
    });

    broadcastFrontDeskEvent({
      type: 'RESERVATION_CANCELLED',
      title: `Cancelled Reservation ${existing.booking_reference}`,
      message: `Room inventory released (${existing.check_in} to ${existing.check_out}). Notified ${notifiedWaitlist.length} waitlist guest(s).`,
      bookingReference: existing.booking_reference
    });

    return {
      cancelled: true,
      bookingReference: existing.booking_reference,
      refundAmount,
      penaltyApplied,
      refundPaymentRef,
      notifiedWaitlist,
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

/**
 * 1. AutomatedWaitlistAndRoomAlertModule:
 * Allows guests viewing an unavailable room/suite to join a priority waitlist for their dates,
 * and automatically dispatches alerts when a cancellation releases that room.
 */
function joinRoomWaitlist({
  roomId = null,
  categoryId = null,
  guestName,
  guestEmail,
  guestPhone = '',
  checkIn,
  checkOut,
  adults = 2,
  children = 0,
  notes = '',
  ipAddress = ''
}) {
  if (!guestName || !guestEmail || !checkIn || !checkOut) {
    const err = new Error('guestName, guestEmail, checkIn, and checkOut are required to join the priority waitlist.');
    err.code = 'MISSING_WAITLIST_FIELDS';
    throw err;
  }
  validateStayDates(checkIn, checkOut);

  const db = getDb();
  let targetCategoryId = categoryId ? Number(categoryId) : null;
  let roomNumber = null;
  if (roomId) {
    const rm = db.prepare('SELECT id, room_number, category_id FROM rooms WHERE id = ?').get(Number(roomId));
    if (rm) {
      targetCategoryId = targetCategoryId || rm.category_id;
      roomNumber = rm.room_number;
    }
  }

  const waitlistRef = `WL-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const res = db.prepare(`
    INSERT INTO waitlist_entries (
      waitlist_reference, room_id, category_id, guest_name, guest_email, guest_phone,
      check_in, check_out, adults, children, notes, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting')
  `).run(
    waitlistRef,
    roomId ? Number(roomId) : null,
    targetCategoryId,
    String(guestName).trim(),
    String(guestEmail).trim().toLowerCase(),
    String(guestPhone || '').trim(),
    checkIn,
    checkOut,
    Math.max(1, Number(adults || 2)),
    Math.max(0, Number(children || 0)),
    String(notes || '').trim()
  );

  const entry = db.prepare('SELECT * FROM waitlist_entries WHERE id = ?').get(Number(res.lastInsertRowid));

  logAudit({
    eventType: 'WAITLIST_JOINED',
    entityType: 'waitlist',
    entityId: waitlistRef,
    actorRole: 'guest',
    actorEmail: entry.guest_email,
    summary: `Guest ${entry.guest_name} joined priority waitlist (${waitlistRef}) for ${roomNumber ? `Room #${roomNumber}` : 'Category'} (${checkIn} to ${checkOut}).`,
    ipAddress
  });

  broadcastFrontDeskEvent({
    type: 'WAITLIST_JOINED',
    title: `Priority Waitlist ${waitlistRef}`,
    message: `${entry.guest_name} joined waitlist for ${checkIn} to ${checkOut}`,
    roomNumber
  });

  return entry;
}

function notifyMatchingWaitlistEntries({ roomIds = [], checkIn, checkOut }) {
  if (!Array.isArray(roomIds) || roomIds.length === 0) return [];
  const db = getDb();
  const notified = [];

  for (const rId of roomIds) {
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(Number(rId));
    if (!room) continue;

    const matches = db.prepare(`
      SELECT * FROM waitlist_entries
      WHERE status = 'waiting'
        AND (room_id = ? OR (room_id IS NULL AND category_id = ?))
        AND check_in < ?
        AND check_out > ?
      ORDER BY id ASC
    `).all(room.id, room.category_id, checkOut, checkIn);

    for (const w of matches) {
      // Verify the room is now genuinely available for the waitlist guest's requested dates
      const avail = checkSingleRoomAvailability(room.id, w.check_in, w.check_out);
      if (avail.available) {
        db.prepare(`
          UPDATE waitlist_entries
          SET status = 'notified', notified_at = datetime('now')
          WHERE id = ?
        `).run(w.id);

        db.prepare(`
          INSERT INTO notifications (
            user_id, recipient_email, recipient_phone, channel, template_code, subject, body, status
          ) VALUES (NULL, ?, ?, 'email', 'WAITLIST_ROOM_RELEASED', ?, ?, 'sent')
        `).run(
          w.guest_email,
          w.guest_phone || '',
          `Maison Aurélia Priority Alert — Room #${room.room_number} (${room.name}) Now Available (${w.waitlist_reference})`,
          `Dear ${w.guest_name}, Room #${room.room_number} (${room.name}) has just become available for your requested stay (${w.check_in} to ${w.check_out}). Reference: ${w.waitlist_reference}.`
        );

        const updatedEntry = db.prepare('SELECT * FROM waitlist_entries WHERE id = ?').get(w.id);
        notified.push(updatedEntry);

        broadcastFrontDeskEvent({
          type: 'WAITLIST_NOTIFIED',
          title: `Waitlist Alert Sent (${w.waitlist_reference})`,
          message: `Notified ${w.guest_name} that Room #${room.room_number} is now available (${w.check_in} to ${w.check_out})`,
          roomNumber: room.room_number
        });
      }
    }
  }

  return notified;
}

/**
 * 2. PrintableTaxInvoiceAndFolioGeneratorModule:
 * Generates an official, print-ready HTML & structured JSON tax + incidental folio invoice.
 */
function generatePrintableTaxInvoice(bookingReference) {
  const res = getReservationByReference(bookingReference);
  if (!res) return null;
  const settings = getHotelSettings();
  const invoiceNo = (res.payments && res.payments[0] && res.payments[0].invoice_number) || `INV-${res.booking_reference}`;

  const roomRowsHtml = (res.rooms || [])
    .map(
      (r) => `
      <tr>
        <td>Suite Accommodation — <strong>#${r.room_number} ${r.room_name}</strong> (${r.check_in} &rarr; ${r.check_out})</td>
        <td style="text-align:center;">${r.nights} night(s)</td>
        <td style="text-align:right;">$${Number(r.nightly_rate).toFixed(2)}</td>
        <td style="text-align:right;">$${Number(r.room_total).toFixed(2)}</td>
      </tr>`
    )
    .join('');

  const addonRowsHtml = (res.addons || [])
    .map(
      (a) => `
      <tr>
        <td>Curated Enhancement — ${a.addon_name}</td>
        <td style="text-align:center;">${a.quantity}</td>
        <td style="text-align:right;">$${Number(a.unit_price).toFixed(2)}</td>
        <td style="text-align:right;">$${Number(a.total_price).toFixed(2)}</td>
      </tr>`
    )
    .join('');

  const folioRowsHtml = (res.folioCharges || [])
    .map(
      (fc) => `
      <tr>
        <td>In-Stay Folio (${fc.category}) — ${fc.description}</td>
        <td style="text-align:center;">${fc.quantity}</td>
        <td style="text-align:right;">$${Number(fc.unit_price).toFixed(2)}</td>
        <td style="text-align:right;">$${Number(fc.total_amount).toFixed(2)}</td>
      </tr>`
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Official Tax &amp; Folio Invoice — ${res.booking_reference}</title>
  <style>
    body { font-family: 'Georgia', serif; color: #0f172a; margin: 40px auto; max-width: 860px; padding: 0 24px; }
    .header { display: flex; justify-content: space-between; border-bottom: 2px solid #c5a059; padding-bottom: 20px; margin-bottom: 24px; }
    .brand { font-size: 26px; letter-spacing: 2px; text-transform: uppercase; color: #0b132b; }
    .sub { font-size: 12px; color: #64748b; font-family: sans-serif; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; font-family: sans-serif; font-size: 13px; }
    th { background: #0b132b; color: #fff; text-align: left; padding: 10px 12px; text-transform: uppercase; font-size: 11px; letter-spacing: 1px; }
    td { padding: 10px 12px; border-bottom: 1px solid #e2e8f0; }
    .totals { margin-left: auto; width: 340px; font-family: sans-serif; font-size: 13px; }
    .totals-row { display: flex; justify-content: space-between; padding: 6px 0; }
    .totals-grand { border-top: 2px solid #0b132b; font-weight: bold; font-size: 16px; padding-top: 10px; margin-top: 6px; }
    @media print { .no-print { display: none; } }
  </style>
</head>
<body>
  <div class="no-print" style="margin-bottom:20px;text-align:right;">
    <button onclick="window.print()" style="background:#c5a059;color:#0b132b;border:none;padding:10px 18px;font-weight:bold;cursor:pointer;border-radius:4px;">🖨️ Print / Save PDF Invoice</button>
  </div>
  <div class="header">
    <div>
      <div class="brand">${settings.hotel_name || 'Maison Aurélia Grand Palace'}</div>
      <div class="sub">Quai du Mont-Blanc 42, 1201 Genève, Switzerland • VAT CHE-114.892.301</div>
    </div>
    <div style="text-align:right;font-family:sans-serif;">
      <div style="font-size:18px;font-weight:bold;">OFFICIAL TAX &amp; FOLIO INVOICE</div>
      <div class="sub">Invoice #: <strong>${invoiceNo}</strong></div>
      <div class="sub">Booking Reference: <strong>${res.booking_reference}</strong></div>
      <div class="sub">Status: <strong>${res.status.toUpperCase()} (${res.payment_status.toUpperCase()})</strong></div>
    </div>
  </div>
  <div style="display:flex;justify-content:space-between;font-family:sans-serif;font-size:13px;margin-bottom:20px;">
    <div>
      <strong>Billed To Guest:</strong><br/>
      ${res.guest_first_name} ${res.guest_last_name}<br/>
      ${res.guest_email} • ${res.guest_phone}
    </div>
    <div style="text-align:right;">
      <strong>Stay Window:</strong> ${res.check_in} to ${res.check_out} (${res.nights} night(s))<br/>
      <strong>Occupancy:</strong> ${res.adults} Adult(s), ${res.children} Child(ren)
    </div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Description</th>
        <th style="text-align:center;">Qty / Nights</th>
        <th style="text-align:right;">Unit Price (USD)</th>
        <th style="text-align:right;">Line Total (USD)</th>
      </tr>
    </thead>
    <tbody>
      ${roomRowsHtml}
      ${addonRowsHtml}
      ${folioRowsHtml}
    </tbody>
  </table>
  <div class="totals">
    <div class="totals-row"><span>Room &amp; Seasonal Subtotal:</span><span>$${Number(res.room_subtotal + res.seasonal_adjustment).toFixed(2)}</span></div>
    <div class="totals-row"><span>Curated Add-Ons Subtotal:</span><span>$${Number(res.extras_subtotal).toFixed(2)}</span></div>
    ${res.discount_amount > 0 ? `<div class="totals-row" style="color:#15803d;"><span>Promo Discount (${res.promo_code}):</span><span>-$${Number(res.discount_amount).toFixed(2)}</span></div>` : ''}
    ${res.loyalty_discount_amount > 0 ? `<div class="totals-row" style="color:#15803d;"><span>Loyalty Points Redeemed (${res.loyalty_points_redeemed} pts):</span><span>-$${Number(res.loyalty_discount_amount).toFixed(2)}</span></div>` : ''}
    <div class="totals-row"><span>VAT &amp; Hospitality Tax:</span><span>$${Number(res.tax_amount).toFixed(2)}</span></div>
    <div class="totals-row"><span>Palace Service Charge:</span><span>$${Number(res.service_fee_amount).toFixed(2)}</span></div>
    <div class="totals-row"><span>Municipal City Levy:</span><span>$${Number(res.city_levy_amount).toFixed(2)}</span></div>
    <div class="totals-row"><span>In-Stay Incidental Folio Charges:</span><span>$${Number(res.incidentalTotal).toFixed(2)}</span></div>
    <div class="totals-row totals-grand"><span>Grand Folio Total (USD):</span><span>$${Number(res.grandFolioTotal).toFixed(2)}</span></div>
    <div class="totals-row"><span>Total Amount Paid:</span><span>$${Number(res.amount_paid).toFixed(2)}</span></div>
    ${res.refunded_amount > 0 ? `<div class="totals-row"><span>Total Refunded:</span><span>$${Number(res.refunded_amount).toFixed(2)}</span></div>` : ''}
    <div class="totals-row" style="font-weight:bold;"><span>Remaining Folio Balance:</span><span>$${Number(res.remainingFolioBalance).toFixed(2)}</span></div>
  </div>
</body>
</html>`;

  return {
    invoiceNumber: invoiceNo,
    bookingReference: res.booking_reference,
    issuedAt: new Date().toISOString(),
    reservation: res,
    html
  };
}

/**
 * 3. HousekeepingStaffAssignmentAndChecklistModule:
 * Records a room inspection checklist, attendant assignment, and updates the room's housekeeping readiness.
 */
function submitHousekeepingChecklist({
  roomId,
  attendantName = 'Marie-Claire Laurent',
  housekeepingStatus = 'clean_inspected',
  linenChanged = true,
  marbleSanitised = true,
  minibarRestocked = true,
  floralsRefreshed = true,
  supervisorVerified = true,
  notes = '',
  inspectedBy = 'Executive Housekeeper',
  actorId = null,
  actorRole = 'admin',
  actorEmail = '',
  ipAddress = ''
}) {
  const validHk = ['clean_inspected', 'dirty_turnover', 'in_progress', 'turndown_complete'];
  if (!validHk.includes(housekeepingStatus)) {
    const err = new Error('Invalid housekeeping status.');
    err.code = 'INVALID_HOUSEKEEPING_STATUS';
    throw err;
  }

  const db = getDb();
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(Number(roomId));
  if (!room) {
    const err = new Error('Room not found.');
    err.code = 'ROOM_NOT_FOUND';
    throw err;
  }

  return withImmediateTransaction(db, () => {
    const ins = db.prepare(`
      INSERT INTO housekeeping_checklists (
        room_id, room_number, attendant_name, housekeeping_status,
        linen_changed, marble_sanitised, minibar_restocked, florals_refreshed,
        supervisor_verified, notes, inspected_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      room.id,
      room.room_number,
      String(attendantName || 'Housekeeping Attendant').trim(),
      housekeepingStatus,
      linenChanged ? 1 : 0,
      marbleSanitised ? 1 : 0,
      minibarRestocked ? 1 : 0,
      floralsRefreshed ? 1 : 0,
      supervisorVerified ? 1 : 0,
      String(notes || '').trim(),
      String(inspectedBy || 'Executive Housekeeper').trim()
    );

    db.prepare(`
      UPDATE rooms
      SET housekeeping_status = ?, housekeeping_updated_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(housekeepingStatus, room.id);

    const checklist = db.prepare('SELECT * FROM housekeeping_checklists WHERE id = ?').get(Number(ins.lastInsertRowid));

    logAudit({
      eventType: 'HOUSEKEEPING_CHECKLIST_COMPLETED',
      entityType: 'room',
      entityId: String(room.id),
      actorId,
      actorRole,
      actorEmail,
      summary: `Completed housekeeping inspection checklist for Room #${room.room_number} (Attendant: ${checklist.attendant_name}, Status: ${housekeepingStatus}).`,
      details: checklist,
      ipAddress
    });

    broadcastFrontDeskEvent({
      type: 'HOUSEKEEPING_UPDATED',
      title: `Room #${room.room_number} Housekeeping: ${housekeepingStatus.toUpperCase()}`,
      message: `Attendant ${checklist.attendant_name} completed checklist (${housekeepingStatus})`,
      roomNumber: room.room_number
    });

    return {
      checklist,
      room: db.prepare('SELECT * FROM rooms WHERE id = ?').get(room.id)
    };
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
  cancelFacilitySlot,
  joinRoomWaitlist,
  notifyMatchingWaitlistEntries,
  generatePrintableTaxInvoice,
  submitHousekeepingChecklist
};
