const express = require('express');
const { getDb, backupDatabase } = require('../db/database');
const {
  hashPassword,
  verifyPassword,
  createAuthToken,
  optionalAuth,
  requireAuth,
  requireRoles
} = require('../middleware/auth');
const { generateCsrfToken } = require('../middleware/security');
const {
  CURRENCY_RATES,
  releaseExpiredHolds,
  getHotelSettings,
  checkSingleRoomAvailability,
  calculateStayPricing,
  formatRoomRecord,
  searchAvailability,
  roundMoney,
  addDays,
  getRoomAvailabilityStrip,
  getFrontDeskTapeChart,
  generateRoomIcalFeed,
  importRoomIcalFeed
} = require('../services/availabilityService');
const {
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
  generatePrintableTaxInvoice,
  submitHousekeepingChecklist
} = require('../services/bookingService');
const {
  registerSseClient,
  broadcastFrontDeskEvent,
  getRecentFrontDeskEvents
} = require('../services/sseService');
const {
  createPaymentToken,
  processPaymentWebhook,
  generatePaymentReference,
  generateInvoiceNumber
} = require('../services/paymentService');
const { sendNotification } = require('../services/notificationService');
const { logAudit, getAuditLogs } = require('../services/auditService');
const { getCloudAdapterStatus, testCloudAdapterHandshake } = require('../services/cloudAdapters');

const router = express.Router();

router.use(optionalAuth);

// ---------------------------------------------------------------------------
// 1. Public Configuration, CSRF, & Catalogue Endpoints
// ---------------------------------------------------------------------------

router.get('/csrf-token', (req, res) => {
  const token = generateCsrfToken(req.user ? String(req.user.id) : 'guest');
  res.json({ csrfToken: token });
});

router.get('/config', (req, res) => {
  const db = getDb();
  const settings = getHotelSettings();
  const addons = db.prepare('SELECT * FROM addons WHERE is_active = 1 ORDER BY id ASC').all();
  const promos = db.prepare(`
    SELECT id, code, description, discount_type, discount_value, min_nights, min_amount, valid_until
    FROM promo_codes WHERE is_active = 1
  `).all();
  const seasonalRates = db.prepare('SELECT * FROM seasonal_rates WHERE is_active = 1 ORDER BY start_date ASC').all();

  res.json({
    settings,
    currencies: CURRENCY_RATES,
    addons,
    promoCodes: promos,
    seasonalRates,
    csrfToken: generateCsrfToken(req.user ? String(req.user.id) : 'guest')
  });
});

router.get('/catalogue', (req, res) => {
  releaseExpiredHolds();
  const db = getDb();
  const settings = getHotelSettings();
  const categories = db.prepare('SELECT * FROM room_categories ORDER BY sort_order ASC, id ASC').all();
  const rooms = db.prepare(`
    SELECT r.*, c.name AS category_name, c.slug AS category_slug
    FROM rooms r
    JOIN room_categories c ON c.id = r.category_id
    ORDER BY c.sort_order ASC, r.room_number ASC
  `).all();

  const formattedRooms = rooms.map((r) => formatRoomRecord(r));
  const formattedCategories = categories.map((cat) => {
    const catRooms = formattedRooms.filter((r) => r.categoryId === cat.id);
    return {
      id: cat.id,
      slug: cat.slug,
      name: cat.name,
      shortDescription: cat.short_description,
      description: cat.description,
      basePrice: cat.base_price,
      maxAdults: cat.max_adults,
      maxChildren: cat.max_children,
      maxOccupancy: cat.max_occupancy,
      bedType: cat.bed_type,
      sizeSqm: cat.size_sqm,
      sizeSqft: cat.size_sqft,
      heroImage: cat.hero_image,
      gallery: JSON.parse(cat.gallery_json || '[]'),
      amenities: JSON.parse(cat.amenities_json || '[]'),
      facilities: JSON.parse(cat.facilities_json || '[]'),
      includedServices: JSON.parse(cat.included_services_json || '[]'),
      checkInPolicy: cat.check_in_policy,
      checkOutPolicy: cat.check_out_policy,
      cancellationPolicy: cat.cancellation_policy,
      refundPolicy: cat.refund_policy,
      isFeatured: Boolean(cat.is_featured),
      totalRooms: catRooms.length,
      activeRooms: catRooms.filter((r) => r.status === 'available').length,
      rooms: catRooms
    };
  });

  res.json({
    environmentMode: settings.environment_mode,
    environmentBanner: settings.environment_banner,
    categories: formattedCategories,
    rooms: formattedRooms
  });
});

router.get('/rooms/:id', (req, res) => {
  releaseExpiredHolds();
  const db = getDb();
  const roomId = Number(req.params.id);
  const room = db.prepare(`
    SELECT r.*, c.name AS category_name, c.slug AS category_slug
    FROM rooms r
    JOIN room_categories c ON c.id = r.category_id
    WHERE r.id = ?
  `).get(roomId);

  if (!room) {
    return res.status(404).json({ error: 'ROOM_NOT_FOUND', message: 'Room not found.' });
  }

  const formatted = formatRoomRecord(room);

  // Anonymized unavailable ranges for room calendar display
  const bookedRanges = db.prepare(`
    SELECT rr.check_in AS startDate, rr.check_out AS endDate, 'booked' AS type
    FROM reservation_rooms rr
    JOIN reservations res ON res.id = rr.reservation_id
    WHERE rr.room_id = ? AND rr.status = 'active' AND res.status IN ('confirmed', 'checked_in')
    ORDER BY rr.check_in ASC
  `).all(roomId);

  const maintenanceRanges = db.prepare(`
    SELECT start_date AS startDate, end_date AS endDate, 'maintenance' AS type, reason
    FROM maintenance_blocks
    WHERE room_id = ? AND status = 'active'
    ORDER BY start_date ASC
  `).all(roomId);

  const holdRanges = db.prepare(`
    SELECT check_in AS startDate, check_out AS endDate, 'held' AS type, expires_at AS expiresAt
    FROM room_holds
    WHERE room_id = ? AND status = 'ACTIVE' AND expires_at > datetime('now')
  `).all(roomId);

  let availability = null;
  if (req.query.checkIn && req.query.checkOut) {
    try {
      const check = checkSingleRoomAvailability(roomId, req.query.checkIn, req.query.checkOut, req.query.sessionId);
      const pricing = calculateStayPricing({
        roomIds: [roomId],
        checkIn: req.query.checkIn,
        checkOut: req.query.checkOut,
        adults: Number(req.query.adults || 2),
        children: Number(req.query.children || 0),
        currency: req.query.currency || 'USD'
      });
      availability = {
        ...check,
        heading: check.available ? 'Room Available' : 'Room Unavailable for Selected Dates',
        message: check.available
          ? 'This room is available for your selected dates. You can proceed with your reservation.'
          : 'Sorry, this room has already been booked or is unavailable for part or all of your selected stay. Please choose different dates or explore other available rooms.',
        pricing
      };
    } catch (err) {
      availability = { error: err.message };
    }
  }

  const availabilityStrip = getRoomAvailabilityStrip({
    roomId,
    startDate: req.query.checkIn || new Date().toISOString().slice(0, 10),
    days: 14,
    currency: req.query.currency || 'USD'
  });

  const reviews = db.prepare(`
    SELECT * FROM guest_reviews
    WHERE room_id = ? OR room_number = ?
    ORDER BY id DESC LIMIT 10
  `).all(roomId, room.room_number);

  res.json({
    room: formatted,
    unavailableRanges: [...bookedRanges, ...maintenanceRanges, ...holdRanges],
    availability,
    availabilityStrip,
    reviews
  });
});

router.get('/rooms/:id/availability-strip', (req, res) => {
  const stripData = getRoomAvailabilityStrip({
    roomId: Number(req.params.id),
    startDate: req.query.startDate || null,
    days: Number(req.query.days || 14),
    currency: req.query.currency || 'USD'
  });
  if (!stripData) {
    return res.status(404).json({ error: 'ROOM_NOT_FOUND', message: 'Room not found.' });
  }
  res.json(stripData);
});

router.get('/rooms/:id/calendar.ics', (req, res) => {
  const ics = generateRoomIcalFeed(Number(req.params.id));
  if (!ics) {
    return res.status(404).json({ error: 'ROOM_NOT_FOUND', message: 'Room not found.' });
  }
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="maison-aurelia-room-${req.params.id}.ics"`);
  res.send(ics);
});

router.get('/reviews', (req, res) => {
  const db = getDb();
  let sql = 'SELECT * FROM guest_reviews WHERE 1=1';
  const params = [];

  if (req.query.rating && req.query.rating !== 'all') {
    const minRating = Number(req.query.rating);
    if (!Number.isNaN(minRating)) {
      if (minRating === 5) {
        sql += ' AND rating = 5';
      } else {
        sql += ' AND rating >= ?';
        params.push(minRating);
      }
    }
  }
  if (req.query.roomNumber && req.query.roomNumber !== 'all') {
    sql += ' AND (room_number = ? OR category_name = ?)';
    params.push(req.query.roomNumber, req.query.roomNumber);
  }
  if (req.query.stayType && req.query.stayType !== 'all') {
    sql += ' AND stay_type = ?';
    params.push(req.query.stayType);
  }
  if (req.query.search) {
    const q = `%${req.query.search}%`;
    sql += ' AND (guest_name LIKE ? OR title LIKE ? OR comment LIKE ? OR room_number LIKE ? OR category_name LIKE ?)';
    params.push(q, q, q, q, q);
  }

  const sort = req.query.sort || 'newest';
  if (sort === 'helpful') {
    sql += ' ORDER BY helpful_count DESC, id DESC';
  } else if (sort === 'highest') {
    sql += ' ORDER BY rating DESC, helpful_count DESC, id DESC';
  } else {
    sql += ' ORDER BY id DESC';
  }

  const reviews = db.prepare(sql).all(...params);
  const allReviews = db.prepare('SELECT rating, verified_stay FROM guest_reviews').all();
  const totalReviews = allReviews.length;
  const sumRatings = allReviews.reduce((acc, r) => acc + Number(r.rating || 5), 0);
  const averageRating = totalReviews > 0 ? Number((sumRatings / totalReviews).toFixed(2)) : 5.0;

  const distribution = {
    5: allReviews.filter((r) => Number(r.rating) === 5).length,
    4: allReviews.filter((r) => Number(r.rating) === 4).length,
    3: allReviews.filter((r) => Number(r.rating) === 3).length,
    2: allReviews.filter((r) => Number(r.rating) === 2).length,
    1: allReviews.filter((r) => Number(r.rating) === 1).length
  };

  res.json({
    reviews,
    summary: {
      totalReviews,
      averageRating,
      verifiedCount: allReviews.filter((r) => Number(r.verified_stay || 1) === 1).length,
      distribution
    }
  });
});

// Public / Guest: Submit a Customer Review on the Customer Reviews Page
router.post('/reviews', (req, res) => {
  const {
    guestName,
    guestEmail = '',
    guestCountry = 'Switzerland',
    bookingReference = '',
    roomNumber = '701',
    categoryName = 'Presidential Suite',
    stayType = 'Couple & Leisure',
    rating = 5,
    title,
    comment
  } = req.body;

  const resolvedName = String(
    guestName || (req.user ? `${req.user.first_name} ${req.user.last_name}` : '')
  ).trim();
  const resolvedEmail = String(guestEmail || (req.user && req.user.email) || '').trim().toLowerCase();

  if (!resolvedName || !title || !comment) {
    return res.status(400).json({
      error: 'MISSING_REVIEW_FIELDS',
      message: 'Guest Name, Review Title, and Detailed Review Comment are required.'
    });
  }

  const numRating = Math.min(5, Math.max(1, Math.round(Number(rating) || 5)));
  const db = getDb();

  let matchedResId = null;
  let resolvedRoomId = null;
  let resolvedRoomNum = String(roomNumber || '701').trim();
  let resolvedCategoryName = String(categoryName || 'Palace Suite').trim();
  let resolvedBookingRef = String(bookingReference || '').trim().toUpperCase();
  let isVerified = 1;

  if (resolvedBookingRef) {
    const existingRes = getReservationByReference(resolvedBookingRef);
    if (existingRes && existingRes.status !== 'cancelled') {
      // Check if this reservation already has a review so we don't violate UNIQUE(reservation_id)
      const existingRev = db.prepare('SELECT id FROM guest_reviews WHERE reservation_id = ?').get(existingRes.id);
      if (!existingRev) {
        matchedResId = existingRes.id;
      }
      const firstRoom = (existingRes.rooms && existingRes.rooms[0]) || {};
      if (firstRoom.room_id) resolvedRoomId = firstRoom.room_id;
      if (firstRoom.room_number) resolvedRoomNum = firstRoom.room_number;
      if (firstRoom.category_name) resolvedCategoryName = firstRoom.category_name;
    }
  } else {
    resolvedBookingRef = `AUR-REV-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  }

  if (!resolvedRoomId) {
    const rmRow = db.prepare(`
      SELECT r.id, r.room_number, c.name AS category_name
      FROM rooms r
      LEFT JOIN room_categories c ON c.id = r.category_id
      WHERE r.room_number = ?
    `).get(resolvedRoomNum);
    if (rmRow) {
      resolvedRoomId = rmRow.id;
      resolvedCategoryName = rmRow.category_name || resolvedCategoryName;
    }
  }

  const ins = db.prepare(`
    INSERT INTO guest_reviews (
      reservation_id, booking_reference, room_id, room_number, category_name,
      guest_name, guest_email, guest_country, stay_type, rating, title, comment,
      verified_stay, helpful_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    matchedResId,
    resolvedBookingRef,
    resolvedRoomId,
    resolvedRoomNum,
    resolvedCategoryName,
    resolvedName,
    resolvedEmail,
    String(guestCountry || 'Switzerland').trim(),
    String(stayType || 'Couple & Leisure').trim(),
    numRating,
    String(title).trim(),
    String(comment).trim(),
    isVerified
  );

  const created = db.prepare('SELECT * FROM guest_reviews WHERE id = ?').get(Number(ins.lastInsertRowid));

  logAudit({
    eventType: 'CUSTOMER_REVIEW_PUBLISHED',
    entityType: 'guest_review',
    entityId: String(created.id),
    actorId: req.user ? req.user.id : null,
    actorRole: req.user ? req.user.role : 'guest',
    actorEmail: resolvedEmail || 'guest@maisonaurelia.luxury',
    summary: `Customer review (${numRating}/5 stars) published by ${resolvedName} for Room #${resolvedRoomNum}: "${created.title}".`,
    ipAddress: req.ip
  });

  broadcastFrontDeskEvent({
    type: 'CUSTOMER_REVIEW_SUBMITTED',
    title: `New ${numRating}★ Customer Review (Room #${resolvedRoomNum})`,
    message: `${resolvedName}: "${created.title}"`
  });

  res.status(201).json({ review: created });
});

// Public / Guest: Mark a customer review as helpful
router.post('/reviews/:id/helpful', (req, res) => {
  const db = getDb();
  const revId = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM guest_reviews WHERE id = ?').get(revId);
  if (!existing) {
    return res.status(404).json({ error: 'REVIEW_NOT_FOUND', message: 'Customer review not found.' });
  }
  db.prepare('UPDATE guest_reviews SET helpful_count = helpful_count + 1 WHERE id = ?').run(revId);
  const updated = db.prepare('SELECT * FROM guest_reviews WHERE id = ?').get(revId);
  res.json({ review: updated });
});

// Admin / Staff: Post an official Palace Management response to a customer review
router.post('/admin/reviews/:id/reply', requireRoles('receptionist', 'finance', 'manager', 'admin'), (req, res) => {
  const { responseText } = req.body;
  if (!responseText || !String(responseText).trim()) {
    return res.status(400).json({ error: 'EMPTY_RESPONSE', message: 'Management response cannot be empty.' });
  }

  const db = getDb();
  const revId = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM guest_reviews WHERE id = ?').get(revId);
  if (!existing) {
    return res.status(404).json({ error: 'REVIEW_NOT_FOUND', message: 'Customer review not found.' });
  }

  const responderName = `${req.user.first_name} ${req.user.last_name} — ${req.user.role.toUpperCase()}`;
  db.prepare(`
    UPDATE guest_reviews
    SET admin_response = ?,
        admin_responder_name = ?,
        admin_responded_at = datetime('now')
    WHERE id = ?
  `).run(String(responseText).trim(), responderName, revId);

  const updated = db.prepare('SELECT * FROM guest_reviews WHERE id = ?').get(revId);
  res.json({ review: updated });
});

// Admin / Manager: Delete a customer review
router.delete('/admin/reviews/:id', requireRoles('manager', 'admin'), (req, res) => {
  const db = getDb();
  const revId = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM guest_reviews WHERE id = ?').get(revId);
  if (!existing) {
    return res.status(404).json({ error: 'REVIEW_NOT_FOUND', message: 'Customer review not found.' });
  }
  db.prepare('DELETE FROM guest_reviews WHERE id = ?').run(revId);
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// 2. Real-Time Availability & Dynamic Pricing Endpoints
// ---------------------------------------------------------------------------

function handleAvailabilitySearch(req, res) {
  try {
    const src = req.method === 'POST' ? req.body : req.query;
    const today = new Date().toISOString().slice(0, 10);
    const defaultOut = addDays(today, 3);

    const result = searchAvailability({
      checkIn: src.checkIn || today,
      checkOut: src.checkOut || defaultOut,
      adults: src.adults !== undefined ? Number(src.adults) : 2,
      children: src.children !== undefined ? Number(src.children) : 0,
      roomsRequired: src.roomsRequired !== undefined ? Number(src.roomsRequired) : 1,
      categorySlug: src.categorySlug || null,
      currency: src.currency || 'USD',
      sessionId: src.sessionId || null
    });

    res.json(result);
  } catch (err) {
    res.status(400).json({
      error: err.code || 'AVAILABILITY_SEARCH_ERROR',
      message: err.message
    });
  }
}

router.get('/availability', handleAvailabilitySearch);
router.post('/availability/search', handleAvailabilitySearch);

router.post('/pricing/calculate', (req, res) => {
  try {
    const {
      roomIds = [],
      checkIn,
      checkOut,
      adults = 2,
      children = 0,
      selectedAddons = [],
      promoCode = '',
      redeemLoyaltyPoints = false,
      paymentPlan = 'full',
      currency = 'USD'
    } = req.body;

    const pricing = calculateStayPricing({
      roomIds: Array.isArray(roomIds) ? roomIds.map(Number) : [Number(roomIds)],
      checkIn,
      checkOut,
      adults,
      children,
      selectedAddons,
      promoCode,
      redeemLoyaltyPoints: Boolean(redeemLoyaltyPoints),
      userId: req.user ? req.user.id : null,
      paymentPlan,
      currency
    });

    res.json({ pricing });
  } catch (err) {
    res.status(400).json({
      error: err.code || 'PRICING_ERROR',
      message: err.message
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Checkout Inventory Holds, Tokenisation & Atomic Booking Endpoints
// ---------------------------------------------------------------------------

router.post('/holds', (req, res) => {
  try {
    const {
      roomIds,
      roomId,
      checkIn,
      checkOut,
      adults = 2,
      children = 0,
      sessionId,
      customHoldSeconds
    } = req.body;

    const ids = Array.isArray(roomIds) ? roomIds : roomId ? [roomId] : [];
    const hold = createCheckoutHold({
      roomIds: ids,
      checkIn,
      checkOut,
      adults,
      children,
      sessionId,
      userId: req.user ? req.user.id : null,
      customHoldSeconds,
      ipAddress: req.ip
    });

    res.status(201).json(hold);
  } catch (err) {
    const status = err.code === 'ROOM_UNAVAILABLE' || String(err.message).includes('HOLD_CONFLICT') ? 409 : 400;
    res.status(status).json({
      error: err.code || 'HOLD_CREATION_FAILED',
      message: err.message,
      reason: err.reason || null,
      conflictDetails: err.conflictDetails || null
    });
  }
});

router.delete('/holds/:holdToken', (req, res) => {
  const result = releaseHold(req.params.holdToken, req.query.sessionId || null);
  res.json(result);
});

router.post('/payments/tokenise', (req, res) => {
  try {
    const tokenData = createPaymentToken(req.body);
    res.status(201).json(tokenData);
  } catch (err) {
    res.status(400).json({
      error: err.code || 'TOKENISATION_ERROR',
      message: err.message
    });
  }
});

router.post('/bookings', (req, res) => {
  try {
    const {
      roomIds,
      roomId,
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
      sessionId = ''
    } = req.body;

    const ids = Array.isArray(roomIds) ? roomIds : roomId ? [roomId] : [];
    const reservation = confirmReservation({
      roomIds: ids,
      checkIn,
      checkOut,
      adults,
      children,
      guestFirstName,
      guestLastName,
      guestEmail,
      guestPhone,
      guestCountry,
      specialRequests,
      selectedAddons,
      promoCode,
      redeemLoyaltyPoints: Boolean(redeemLoyaltyPoints),
      paymentMethod,
      paymentPlan,
      paymentToken,
      cardBrand,
      cardLast4,
      bankReference,
      currency,
      holdToken,
      sessionId,
      userId: req.user ? req.user.id : null,
      bookingSource: 'online',
      ipAddress: req.ip
    });

    res.status(201).json({
      confirmed: true,
      bookingReference: reservation.booking_reference,
      reservation
    });
  } catch (err) {
    const isConflict =
      err.code === 'AVAILABILITY_CHANGED_DURING_CHECKOUT' ||
      err.code === 'ROOM_UNAVAILABLE' ||
      String(err.message).includes('DOUBLE_BOOKING_CONFLICT') ||
      String(err.message).includes('MAINTENANCE_BLOCK_CONFLICT');

    const isPaymentFail =
      err.code === 'PAYMENT_DECLINED' ||
      err.code === 'PAYMENT_TOKEN_INVALID' ||
      err.code === 'INVALID_BANK_REFERENCE';

    const status = isConflict ? 409 : isPaymentFail ? 402 : 400;
    res.status(status).json({
      error: err.code || (isConflict ? 'DOUBLE_BOOKING_PREVENTED' : 'BOOKING_FAILED'),
      message: err.message,
      alternativeRooms: err.alternativeRooms || []
    });
  }
});

router.post('/payments/webhook', (req, res) => {
  try {
    const sig = req.headers['x-payment-signature'];
    const result = processPaymentWebhook({
      payload: req.body,
      signatureHeader: sig,
      ipAddress: req.ip
    });
    res.json(result);
  } catch (err) {
    const status = err.code === 'INVALID_WEBHOOK_SIGNATURE' ? 401 : 400;
    res.status(status).json({
      error: err.code || 'WEBHOOK_ERROR',
      message: err.message
    });
  }
});

router.get('/bookings/lookup', (req, res) => {
  const { bookingReference, email } = req.query;
  if (!bookingReference) {
    return res.status(400).json({
      error: 'MISSING_REFERENCE',
      message: 'Booking reference is required.'
    });
  }

  const reservation = getReservationByReference(bookingReference);
  if (!reservation) {
    return res.status(404).json({
      error: 'RESERVATION_NOT_FOUND',
      message: 'No reservation found matching that booking reference.'
    });
  }

  const isStaff = req.user && ['receptionist', 'finance', 'manager', 'admin'].includes(req.user.role);
  const isOwnerUser = req.user && (req.user.id === reservation.user_id || req.user.email.toLowerCase() === reservation.guest_email.toLowerCase());
  const matchesQueryEmail = email && String(email).trim().toLowerCase() === reservation.guest_email.toLowerCase();

  if (!isStaff && !isOwnerUser && !matchesQueryEmail) {
    return res.status(403).json({
      error: 'EMAIL_VERIFICATION_REQUIRED',
      message: 'Please provide the email address used when making this reservation to view its details.'
    });
  }

  res.json({ reservation });
});

router.post('/bookings/:bookingReference/cancel', (req, res) => {
  try {
    const reservation = getReservationByReference(req.params.bookingReference);
    if (!reservation) {
      return res.status(404).json({ error: 'RESERVATION_NOT_FOUND', message: 'Reservation not found.' });
    }

    const isStaff = req.user && ['receptionist', 'finance', 'manager', 'admin'].includes(req.user.role);
    const isOwnerUser = req.user && (req.user.id === reservation.user_id || req.user.email.toLowerCase() === reservation.guest_email.toLowerCase());
    const matchesBodyEmail = req.body.email && String(req.body.email).trim().toLowerCase() === reservation.guest_email.toLowerCase();

    if (!isStaff && !isOwnerUser && !matchesBodyEmail) {
      return res.status(403).json({
        error: 'UNAUTHORIZED_CANCELLATION',
        message: 'Please verify the reservation email address or sign in to cancel this booking.'
      });
    }

    const result = cancelReservation({
      bookingReference: reservation.booking_reference,
      reason: req.body.reason || 'Guest requested cancellation',
      actorId: req.user ? req.user.id : null,
      actorRole: req.user ? req.user.role : 'guest',
      actorEmail: req.user ? req.user.email : reservation.guest_email,
      forceFullRefund: Boolean(isStaff && req.body.forceFullRefund),
      ipAddress: req.ip
    });

    res.json(result);
  } catch (err) {
    res.status(400).json({
      error: err.code || 'CANCELLATION_FAILED',
      message: err.message
    });
  }
});

router.patch('/bookings/:bookingReference/requests', (req, res) => {
  const reservation = getReservationByReference(req.params.bookingReference);
  if (!reservation) {
    return res.status(404).json({ error: 'RESERVATION_NOT_FOUND', message: 'Reservation not found.' });
  }
  const isStaff = req.user && ['receptionist', 'finance', 'manager', 'admin'].includes(req.user.role);
  const isOwnerUser = req.user && (req.user.id === reservation.user_id || req.user.email.toLowerCase() === reservation.guest_email.toLowerCase());
  const matchesBodyEmail = req.body.email && String(req.body.email).trim().toLowerCase() === reservation.guest_email.toLowerCase();

  if (!isStaff && !isOwnerUser && !matchesBodyEmail) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Verification required to modify reservation preferences.' });
  }

  const db = getDb();
  db.prepare(`
    UPDATE reservations
    SET special_requests = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(String(req.body.specialRequests || ''), reservation.id);

  res.json({ reservation: getReservationByReference(reservation.booking_reference) });
});

router.post('/bookings/:bookingReference/modify-dates', (req, res) => {
  try {
    const reservation = getReservationByReference(req.params.bookingReference);
    if (!reservation) {
      return res.status(404).json({ error: 'RESERVATION_NOT_FOUND', message: 'Reservation not found.' });
    }
    const isStaff = req.user && ['receptionist', 'finance', 'manager', 'admin'].includes(req.user.role);
    const isOwnerUser = req.user && (req.user.id === reservation.user_id || req.user.email.toLowerCase() === reservation.guest_email.toLowerCase());
    const matchesBodyEmail = req.body.email && String(req.body.email).trim().toLowerCase() === reservation.guest_email.toLowerCase();

    if (!isStaff && !isOwnerUser && !matchesBodyEmail) {
      return res.status(403).json({
        error: 'UNAUTHORIZED_MODIFICATION',
        message: 'Please verify your email address or sign in to modify reservation dates.'
      });
    }

    const result = modifyReservationDates({
      bookingReference: reservation.booking_reference,
      newCheckIn: req.body.newCheckIn || req.body.checkIn,
      newCheckOut: req.body.newCheckOut || req.body.checkOut,
      actorId: req.user ? req.user.id : null,
      actorRole: req.user ? req.user.role : 'guest',
      actorEmail: req.user ? req.user.email : reservation.guest_email,
      ipAddress: req.ip
    });

    res.json(result);
  } catch (err) {
    const isConflict =
      String(err.message).includes('DOUBLE_BOOKING_CONFLICT') ||
      String(err.message).includes('MAINTENANCE_BLOCK_CONFLICT');
    res.status(isConflict ? 409 : 400).json({
      error: err.code || (isConflict ? 'DATE_MODIFICATION_CONFLICT' : 'MODIFICATION_FAILED'),
      message: isConflict
        ? 'The requested new dates overlap with another reservation or maintenance block on this physical room.'
        : err.message
    });
  }
});

router.put('/bookings/:bookingReference/dossier', (req, res) => {
  try {
    const reservation = getReservationByReference(req.params.bookingReference);
    if (!reservation) {
      return res.status(404).json({ error: 'RESERVATION_NOT_FOUND', message: 'Reservation not found.' });
    }
    const isStaff = req.user && ['receptionist', 'finance', 'manager', 'admin'].includes(req.user.role);
    const isOwnerUser = req.user && (req.user.id === reservation.user_id || req.user.email.toLowerCase() === reservation.guest_email.toLowerCase());
    const matchesBodyEmail = req.body.email && String(req.body.email).trim().toLowerCase() === reservation.guest_email.toLowerCase();

    if (!isStaff && !isOwnerUser && !matchesBodyEmail) {
      return res.status(403).json({
        error: 'UNAUTHORIZED_DOSSIER_UPDATE',
        message: 'Please verify your reservation email address or sign in to update your Pre-Arrival Butler Dossier.'
      });
    }

    const updated = savePreArrivalDossier({
      bookingReference: reservation.booking_reference,
      pillowPreference: req.body.pillowPreference,
      suiteTemperatureC: req.body.suiteTemperatureC,
      turndownScent: req.body.turndownScent,
      arrivalTransportMode: req.body.arrivalTransportMode,
      flightOrTailNumber: req.body.flightOrTailNumber,
      estimatedArrivalTime: req.body.estimatedArrivalTime,
      dietaryAllergies: req.body.dietaryAllergies,
      butlerNotes: req.body.butlerNotes,
      actorEmail: req.user ? req.user.email : reservation.guest_email,
      ipAddress: req.ip
    });

    res.json({ reservation: updated, preArrivalDossier: updated.preArrivalDossier });
  } catch (err) {
    res.status(400).json({ error: err.code || 'DOSSIER_UPDATE_FAILED', message: err.message });
  }
});

router.get('/bookings/:bookingReference/folio', (req, res) => {
  const reservation = getReservationByReference(req.params.bookingReference);
  if (!reservation) {
    return res.status(404).json({ error: 'RESERVATION_NOT_FOUND', message: 'Reservation not found.' });
  }
  const isStaff = req.user && ['receptionist', 'finance', 'manager', 'admin'].includes(req.user.role);
  const isOwnerUser = req.user && (req.user.id === reservation.user_id || req.user.email.toLowerCase() === reservation.guest_email.toLowerCase());
  const matchesQueryEmail = req.query.email && String(req.query.email).trim().toLowerCase() === reservation.guest_email.toLowerCase();

  if (!isStaff && !isOwnerUser && !matchesQueryEmail) {
    return res.status(403).json({
      error: 'EMAIL_VERIFICATION_REQUIRED',
      message: 'Please provide the reservation email address or sign in to view this folio.'
    });
  }

  res.json({
    bookingReference: reservation.booking_reference,
    roomTotal: reservation.total_amount,
    incidentalTotal: reservation.incidentalTotal,
    grandFolioTotal: reservation.grandFolioTotal,
    amountPaid: reservation.amount_paid,
    refundedAmount: reservation.refunded_amount,
    remainingFolioBalance: reservation.remainingFolioBalance,
    folioCharges: reservation.folioCharges,
    payments: reservation.payments
  });
});

router.post('/bookings/:bookingReference/review', (req, res) => {
  try {
    const reservation = getReservationByReference(req.params.bookingReference);
    if (!reservation) {
      return res.status(404).json({ error: 'RESERVATION_NOT_FOUND', message: 'Reservation not found.' });
    }
    const isStaff = req.user && ['receptionist', 'finance', 'manager', 'admin'].includes(req.user.role);
    const isOwnerUser = req.user && (req.user.id === reservation.user_id || req.user.email.toLowerCase() === reservation.guest_email.toLowerCase());
    const matchesBodyEmail = req.body.email && String(req.body.email).trim().toLowerCase() === reservation.guest_email.toLowerCase();

    if (!isStaff && !isOwnerUser && !matchesBodyEmail) {
      return res.status(403).json({
        error: 'UNAUTHORIZED_REVIEW',
        message: 'Please verify your reservation email address to submit a verified stay review.'
      });
    }

    const updated = submitGuestReview({
      bookingReference: reservation.booking_reference,
      rating: req.body.rating,
      title: req.body.title,
      comment: req.body.comment,
      ipAddress: req.ip
    });

    res.status(201).json({ reservation: updated, review: updated.guestReview });
  } catch (err) {
    res.status(400).json({ error: err.code || 'REVIEW_SUBMIT_FAILED', message: err.message });
  }
});

// DiningAndSpaSlotBookingModule Endpoints
router.get('/bookings/:bookingReference/facilities', (req, res) => {
  const reservation = getReservationByReference(req.params.bookingReference);
  if (!reservation) {
    return res.status(404).json({ error: 'RESERVATION_NOT_FOUND', message: 'Reservation not found.' });
  }
  res.json({ facilityBookings: reservation.facilityBookings || [] });
});

router.post('/bookings/:bookingReference/facilities', (req, res) => {
  try {
    const reservation = getReservationByReference(req.params.bookingReference);
    if (!reservation) {
      return res.status(404).json({ error: 'RESERVATION_NOT_FOUND', message: 'Reservation not found.' });
    }
    const isStaff = req.user && ['receptionist', 'finance', 'manager', 'admin'].includes(req.user.role);
    const isOwnerUser = req.user && (req.user.id === reservation.user_id || req.user.email.toLowerCase() === reservation.guest_email.toLowerCase());
    const matchesBodyEmail = req.body.email && String(req.body.email).trim().toLowerCase() === reservation.guest_email.toLowerCase();

    if (!isStaff && !isOwnerUser && !matchesBodyEmail) {
      return res.status(403).json({
        error: 'UNAUTHORIZED_FACILITY_BOOKING',
        message: 'Please verify your reservation email address or sign in to reserve dining or thermal spa slots.'
      });
    }

    const updated = bookFacilitySlot({
      bookingReference: reservation.booking_reference,
      facilityType: req.body.facilityType || 'michelin_dining',
      reservationDate: req.body.reservationDate || reservation.check_in,
      slotTime: req.body.slotTime || '19:30',
      guestsCount: req.body.guestsCount || reservation.adults,
      treatmentOrMenu: req.body.treatmentOrMenu || 'Seven-Course Michelin Tasting Menu',
      price: req.body.price !== undefined ? Number(req.body.price) : 0,
      actorEmail: req.user ? req.user.email : reservation.guest_email,
      ipAddress: req.ip
    });

    res.status(201).json({
      reservation: updated,
      facilityBookings: updated.facilityBookings
    });
  } catch (err) {
    const status = err.code === 'FACILITY_SLOT_ALREADY_BOOKED' ? 409 : 400;
    res.status(status).json({ error: err.code || 'FACILITY_BOOKING_FAILED', message: err.message });
  }
});

router.delete('/bookings/:bookingReference/facilities/:slotId', (req, res) => {
  try {
    const reservation = getReservationByReference(req.params.bookingReference);
    if (!reservation) {
      return res.status(404).json({ error: 'RESERVATION_NOT_FOUND', message: 'Reservation not found.' });
    }
    const isStaff = req.user && ['receptionist', 'finance', 'manager', 'admin'].includes(req.user.role);
    const isOwnerUser = req.user && (req.user.id === reservation.user_id || req.user.email.toLowerCase() === reservation.guest_email.toLowerCase());
    const matchesEmail = (req.query.email || req.body?.email || '').toLowerCase() === reservation.guest_email.toLowerCase();

    if (!isStaff && !isOwnerUser && !matchesEmail) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Verification required to cancel facility slot.' });
    }

    const updated = cancelFacilitySlot({
      bookingReference: reservation.booking_reference,
      slotId: Number(req.params.slotId),
      actorEmail: req.user ? req.user.email : reservation.guest_email,
      ipAddress: req.ip
    });
    res.json({ reservation: updated, facilityBookings: updated.facilityBookings });
  } catch (err) {
    res.status(400).json({ error: err.code || 'FACILITY_CANCEL_FAILED', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// 4. Authentication & Guest Account Endpoints
// ---------------------------------------------------------------------------

router.post('/auth/register', (req, res) => {
  const { email, password, firstName, lastName, phone = '', country = '' } = req.body;
  if (!email || !password || !firstName || !lastName) {
    return res.status(400).json({
      error: 'MISSING_FIELDS',
      message: 'First name, last name, email, and password are required.'
    });
  }
  if (String(password).length < 8) {
    return res.status(400).json({
      error: 'WEAK_PASSWORD',
      message: 'Password must be at least 8 characters long.'
    });
  }

  const db = getDb();
  const cleanEmail = String(email).trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(cleanEmail);
  if (existing) {
    return res.status(409).json({
      error: 'EMAIL_ALREADY_REGISTERED',
      message: 'An account with this email address already exists.'
    });
  }

  const { salt, hash } = hashPassword(password);
  const result = db.prepare(`
    INSERT INTO users (email, password_hash, password_salt, first_name, last_name, phone, country, role, loyalty_tier, loyalty_points)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'guest', 'Aurélia Privé', 1000)
  `).run(cleanEmail, hash, salt, String(firstName).trim(), String(lastName).trim(), String(phone).trim(), String(country).trim());

  const user = db.prepare(
    'SELECT id, email, first_name, last_name, phone, country, role, loyalty_tier, loyalty_points FROM users WHERE id = ?'
  ).get(Number(result.lastInsertRowid));

  // Link any existing guest reservations with matching email to this new user account
  db.prepare('UPDATE reservations SET user_id = ? WHERE LOWER(guest_email) = ? AND user_id IS NULL').run(user.id, cleanEmail);

  const token = createAuthToken(user);
  res.status(201).json({ token, user });
});

router.post('/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({
      error: 'MISSING_CREDENTIALS',
      message: 'Email and password are required.'
    });
  }

  const db = getDb();
  const userRow = db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(String(email).trim());
  if (!userRow || !userRow.is_active) {
    return res.status(401).json({
      error: 'INVALID_CREDENTIALS',
      message: 'Invalid email or password.'
    });
  }

  const valid = verifyPassword(password, userRow.password_salt, userRow.password_hash);
  if (!valid) {
    return res.status(401).json({
      error: 'INVALID_CREDENTIALS',
      message: 'Invalid email or password.'
    });
  }

  const user = {
    id: userRow.id,
    email: userRow.email,
    first_name: userRow.first_name,
    last_name: userRow.last_name,
    phone: userRow.phone,
    country: userRow.country,
    role: userRow.role,
    loyalty_tier: userRow.loyalty_tier,
    loyalty_points: userRow.loyalty_points
  };

  const token = createAuthToken(user);
  res.json({ token, user });
});

router.get('/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

router.get('/guest/bookings', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT booking_reference
    FROM reservations
    WHERE user_id = ? OR LOWER(guest_email) = LOWER(?)
    ORDER BY id DESC
  `).all(req.user.id, req.user.email);

  const reservations = rows.map((r) => getReservationByReference(r.booking_reference));
  res.json({ reservations });
});

router.get('/guest/notifications', requireAuth, (req, res) => {
  const db = getDb();
  const notifications = db.prepare(`
    SELECT * FROM notifications
    WHERE user_id = ? OR LOWER(recipient_email) = LOWER(?)
    ORDER BY id DESC LIMIT 50
  `).all(req.user.id, req.user.email);

  res.json({ notifications });
});

router.get('/guest/dashboard', requireAuth, (req, res) => {
  const db = getDb();
  const freshUser = db.prepare(`
    SELECT id, email, first_name, last_name, phone, country, role, loyalty_tier, loyalty_points, is_active, created_at
    FROM users WHERE id = ?
  `).get(req.user.id);

  const refRows = db.prepare(`
    SELECT booking_reference
    FROM reservations
    WHERE user_id = ? OR LOWER(guest_email) = LOWER(?)
    ORDER BY id DESC
  `).all(req.user.id, req.user.email);

  const reservations = refRows.map((r) => getReservationByReference(r.booking_reference)).filter(Boolean);
  const activeStays = reservations.filter((r) => r.status !== 'cancelled');
  const today = new Date().toISOString().slice(0, 10);
  const upcomingStays = activeStays.filter((r) => r.check_out >= today);
  const totalNights = activeStays.reduce((sum, r) => sum + Number(r.nights || 0), 0);
  const lifetimeSpendUsd = roundMoney(
    activeStays.reduce((sum, r) => sum + Number(r.grandFolioTotal || r.total_amount || 0), 0)
  );

  const pts = Number(freshUser?.loyalty_points || 0);
  const redeemableCreditUsd = roundMoney(Math.floor(pts / 10));
  let nextTier = 'Imperial Black';
  let pointsToNextTier = 0;
  if (pts < 5000) {
    nextTier = 'Gold Sanctuary';
    pointsToNextTier = 5000 - pts;
  } else if (pts < 15000) {
    nextTier = 'Imperial Black';
    pointsToNextTier = 15000 - pts;
  }

  const waitlist = db.prepare(`
    SELECT w.*, r.room_number, r.name AS room_name, c.name AS category_name
    FROM waitlist_entries w
    LEFT JOIN rooms r ON r.id = w.room_id
    LEFT JOIN room_categories c ON c.id = w.category_id
    WHERE LOWER(w.guest_email) = LOWER(?)
    ORDER BY w.id DESC
  `).all(req.user.email);

  const conciergeRequests = db.prepare(`
    SELECT * FROM concierge_requests
    WHERE user_id = ? OR LOWER(guest_email) = LOWER(?)
    ORDER BY id DESC
  `).all(req.user.id, req.user.email);

  const notifications = db.prepare(`
    SELECT * FROM notifications
    WHERE user_id = ? OR LOWER(recipient_email) = LOWER(?)
    ORDER BY id DESC LIMIT 40
  `).all(req.user.id, req.user.email);

  const messageThreads = db.prepare(`
    SELECT
      t.*,
      (SELECT COUNT(*) FROM thread_messages tm WHERE tm.thread_id = t.id) AS messages_count,
      (SELECT body FROM thread_messages tm WHERE tm.thread_id = t.id ORDER BY tm.id DESC LIMIT 1) AS last_message_preview,
      (SELECT sender_name FROM thread_messages tm WHERE tm.thread_id = t.id ORDER BY tm.id DESC LIMIT 1) AS last_sender_name
    FROM message_threads t
    WHERE t.user_id = ? OR LOWER(t.guest_email) = LOWER(?)
    ORDER BY t.last_message_at DESC, t.id DESC
  `).all(req.user.id, req.user.email);

  const unreadMessagesCount = messageThreads.reduce((sum, t) => sum + Number(t.unread_by_guest || 0), 0);

  res.json({
    user: freshUser,
    metrics: {
      totalStays: activeStays.length,
      upcomingStaysCount: upcomingStays.length,
      totalNights,
      lifetimeSpendUsd,
      loyaltyPoints: pts,
      redeemableCreditUsd,
      loyaltyTier: freshUser?.loyalty_tier || 'Aurélia Privé',
      nextTier,
      pointsToNextTier,
      unreadMessagesCount
    },
    reservations,
    waitlist,
    conciergeRequests,
    messageThreads,
    notifications
  });
});

router.put('/guest/profile', requireAuth, (req, res) => {
  const { firstName, lastName, phone = '', country = '' } = req.body;
  if (!firstName || !lastName) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'First name and last name are required.' });
  }
  const db = getDb();
  db.prepare(`
    UPDATE users
    SET first_name = ?, last_name = ?, phone = ?, country = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(String(firstName).trim(), String(lastName).trim(), String(phone).trim(), String(country).trim(), req.user.id);

  const updated = db.prepare(`
    SELECT id, email, first_name, last_name, phone, country, role, loyalty_tier, loyalty_points, is_active, created_at
    FROM users WHERE id = ?
  `).get(req.user.id);

  logAudit({
    eventType: 'GUEST_PROFILE_UPDATED',
    entityType: 'user',
    entityId: String(req.user.id),
    actorId: req.user.id,
    actorRole: req.user.role,
    actorEmail: req.user.email,
    summary: `User ${req.user.email} updated their profile details.`,
    ipAddress: req.ip
  });

  res.json({ user: updated });
});

router.put('/guest/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword || String(newPassword).length < 8) {
    return res.status(400).json({
      error: 'INVALID_PASSWORD_INPUT',
      message: 'Current password and a new password of at least 8 characters are required.'
    });
  }
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!row || !verifyPassword(currentPassword, row.password_salt, row.password_hash)) {
    return res.status(401).json({ error: 'INVALID_CURRENT_PASSWORD', message: 'Current password is incorrect.' });
  }

  const { salt, hash } = hashPassword(newPassword);
  db.prepare("UPDATE users SET password_hash = ?, password_salt = ?, updated_at = datetime('now') WHERE id = ?").run(
    hash,
    salt,
    req.user.id
  );

  logAudit({
    eventType: 'USER_PASSWORD_CHANGED',
    entityType: 'user',
    entityId: String(req.user.id),
    actorId: req.user.id,
    actorRole: req.user.role,
    actorEmail: req.user.email,
    summary: `User ${req.user.email} updated their account password.`,
    ipAddress: req.ip
  });

  res.json({ updated: true });
});

router.delete('/guest/waitlist/:id', requireAuth, (req, res) => {
  const db = getDb();
  const entry = db.prepare('SELECT * FROM waitlist_entries WHERE id = ?').get(Number(req.params.id));
  if (!entry || entry.guest_email.toLowerCase() !== req.user.email.toLowerCase()) {
    return res.status(404).json({ error: 'WAITLIST_NOT_FOUND', message: 'Waitlist entry not found.' });
  }
  db.prepare("UPDATE waitlist_entries SET status = 'cancelled' WHERE id = ?").run(entry.id);
  res.json({ cancelled: true });
});

router.get('/guest/concierge-requests', requireAuth, (req, res) => {
  const db = getDb();
  const requests = db.prepare(`
    SELECT * FROM concierge_requests
    WHERE user_id = ? OR LOWER(guest_email) = LOWER(?)
    ORDER BY id DESC
  `).all(req.user.id, req.user.email);
  res.json({ conciergeRequests: requests });
});

router.post('/guest/concierge-requests', requireAuth, (req, res) => {
  const {
    bookingReference = '',
    category = 'Chauffeur & Transport',
    priority = 'normal',
    subject,
    details,
    preferredTime = ''
  } = req.body;

  if (!subject || !details) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Subject and request details are required.' });
  }

  const db = getDb();
  const ref = `CON-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const validPriority = priority === 'vip_urgent' ? 'vip_urgent' : 'normal';
  const result = db.prepare(`
    INSERT INTO concierge_requests (
      request_reference, user_id, booking_reference, guest_name, guest_email,
      category, priority, subject, details, preferred_time, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    ref,
    req.user.id,
    String(bookingReference || '').trim(),
    `${req.user.first_name} ${req.user.last_name}`,
    req.user.email,
    String(category).trim(),
    validPriority,
    String(subject).trim(),
    String(details).trim(),
    String(preferredTime || '').trim()
  );

  const created = db.prepare('SELECT * FROM concierge_requests WHERE id = ?').get(Number(result.lastInsertRowid));

  logAudit({
    eventType: 'CONCIERGE_REQUEST_CREATED',
    entityType: 'concierge_request',
    entityId: ref,
    actorId: req.user.id,
    actorRole: req.user.role,
    actorEmail: req.user.email,
    summary: `Guest ${req.user.email} submitted concierge request ${ref} (${created.category}: ${created.subject}).`,
    ipAddress: req.ip
  });

  res.status(201).json({ conciergeRequest: created });
});

// ---------------------------------------------------------------------------
// 5. Hotel Administration Dashboard Endpoints (Protected by RBAC)
// ---------------------------------------------------------------------------

router.get('/admin/overview', requireRoles('receptionist', 'finance', 'manager', 'admin'), (req, res) => {
  releaseExpiredHolds();
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  const totalRooms = db.prepare('SELECT COUNT(*) AS cnt FROM rooms').get().cnt;
  const availableStatusRooms = db.prepare("SELECT COUNT(*) AS cnt FROM rooms WHERE status = 'available'").get().cnt;
  const maintenanceStatusRooms = db.prepare("SELECT COUNT(*) AS cnt FROM rooms WHERE status = 'maintenance'").get().cnt;

  const occupiedToday = db.prepare(`
    SELECT COUNT(DISTINCT room_id) AS cnt
    FROM reservation_rooms rr
    JOIN reservations res ON res.id = rr.reservation_id
    WHERE rr.status = 'active'
      AND res.status IN ('confirmed', 'checked_in')
      AND rr.check_in <= ? AND rr.check_out > ?
  `).get(today, today).cnt;

  const activeHoldsCount = db.prepare(`
    SELECT COUNT(*) AS cnt FROM room_holds WHERE status = 'ACTIVE' AND expires_at > datetime('now')
  `).get().cnt;

  const financials = db.prepare(`
    SELECT
      COUNT(*) AS totalBookings,
      SUM(CASE WHEN status != 'cancelled' THEN 1 ELSE 0 END) AS activeBookings,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelledBookings,
      COALESCE(SUM(CASE WHEN status != 'cancelled' THEN total_amount ELSE 0 END), 0) AS contractedRevenue,
      COALESCE(SUM(amount_paid), 0) AS grossCollected,
      COALESCE(SUM(refunded_amount), 0) AS totalRefunded,
      COALESCE(SUM(CASE WHEN status != 'cancelled' THEN nights * rooms_count ELSE 0 END), 0) AS roomNightsSold
    FROM reservations
  `).get();

  const netCollected = roundMoney(financials.grossCollected - financials.totalRefunded);
  const adr = financials.roomNightsSold > 0
    ? roundMoney(financials.contractedRevenue / financials.roomNightsSold)
    : 0;
  const occupancyRate = totalRooms > 0
    ? roundMoney((occupiedToday / totalRooms) * 100)
    : 0;
  const revPar = totalRooms > 0
    ? roundMoney(financials.contractedRevenue / Math.max(1, totalRooms))
    : 0;

  const upcomingArrivals = db.prepare(`
    SELECT * FROM reservations
    WHERE status IN ('confirmed', 'checked_in') AND check_in >= ?
    ORDER BY check_in ASC LIMIT 10
  `).all(today);

  const revenueByCategory = db.prepare(`
    SELECT
      rr.category_name AS categoryName,
      COUNT(*) AS bookingsCount,
      ROUND(SUM(rr.room_total), 2) AS categoryRevenue
    FROM reservation_rooms rr
    JOIN reservations res ON res.id = rr.reservation_id
    WHERE rr.status = 'active' AND res.status != 'cancelled'
    GROUP BY rr.category_name
    ORDER BY categoryRevenue DESC
  `).all();

  res.json({
    metrics: {
      totalRooms,
      availableStatusRooms,
      maintenanceStatusRooms,
      occupiedToday,
      activeHoldsCount,
      occupancyRatePercent: occupancyRate,
      totalBookings: financials.totalBookings,
      activeBookings: financials.activeBookings,
      cancelledBookings: financials.cancelledBookings,
      contractedRevenue: roundMoney(financials.contractedRevenue),
      grossCollected: roundMoney(financials.grossCollected),
      totalRefunded: roundMoney(financials.totalRefunded),
      netCollected,
      roomNightsSold: financials.roomNightsSold,
      averageDailyRate: adr,
      revPar
    },
    upcomingArrivals,
    revenueByCategory
  });
});

// Admin Category CRUD
router.post('/admin/categories', requireRoles('manager', 'admin'), (req, res) => {
  const {
    name,
    slug,
    shortDescription,
    description,
    basePrice,
    maxAdults = 2,
    maxChildren = 1,
    maxOccupancy = 3,
    bedType = '1 Emperor King Bed',
    sizeSqm = 50,
    sizeSqft = 538,
    heroImage = '/images/room-deluxe.jpg',
    amenities = [],
    facilities = [],
    includedServices = [],
    checkInPolicy = 'Check-in from 15:00.',
    checkOutPolicy = 'Check-out until 12:00.',
    cancellationPolicy = 'Complimentary cancellation up to 48 hours prior to arrival.',
    refundPolicy = 'Automatic refund to original payment method.',
    isFeatured = false
  } = req.body;

  if (!name || !basePrice) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Category name and basePrice are required.' });
  }

  const finalSlug = (slug || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const db = getDb();

  try {
    const result = db.prepare(`
      INSERT INTO room_categories (
        slug, name, short_description, description, base_price,
        max_adults, max_children, max_occupancy, bed_type,
        size_sqm, size_sqft, hero_image, gallery_json,
        amenities_json, facilities_json, included_services_json,
        check_in_policy, check_out_policy, cancellation_policy, refund_policy, is_featured
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      finalSlug,
      String(name).trim(),
      String(shortDescription || name).trim(),
      String(description || shortDescription || name).trim(),
      Number(basePrice),
      Number(maxAdults),
      Number(maxChildren),
      Number(maxOccupancy),
      bedType,
      Number(sizeSqm),
      Number(sizeSqft),
      heroImage,
      JSON.stringify([heroImage]),
      JSON.stringify(Array.isArray(amenities) ? amenities : String(amenities).split(',').map((s) => s.trim()).filter(Boolean)),
      JSON.stringify(Array.isArray(facilities) ? facilities : String(facilities).split(',').map((s) => s.trim()).filter(Boolean)),
      JSON.stringify(Array.isArray(includedServices) ? includedServices : String(includedServices).split(',').map((s) => s.trim()).filter(Boolean)),
      checkInPolicy,
      checkOutPolicy,
      cancellationPolicy,
      refundPolicy,
      isFeatured ? 1 : 0
    );

    const created = db.prepare('SELECT * FROM room_categories WHERE id = ?').get(Number(result.lastInsertRowid));
    logAudit({
      eventType: 'CATEGORY_CREATED',
      entityType: 'room_category',
      entityId: created.slug,
      actorId: req.user.id,
      actorRole: req.user.role,
      actorEmail: req.user.email,
      summary: `Created room category "${created.name}" ($${created.base_price}/night).`,
      details: created,
      ipAddress: req.ip
    });

    res.status(201).json({ category: created });
  } catch (err) {
    res.status(400).json({ error: 'CATEGORY_CREATE_FAILED', message: err.message });
  }
});

router.put('/admin/categories/:id', requireRoles('manager', 'admin'), (req, res) => {
  const db = getDb();
  const catId = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM room_categories WHERE id = ?').get(catId);
  if (!existing) {
    return res.status(404).json({ error: 'CATEGORY_NOT_FOUND', message: 'Category not found.' });
  }

  const {
    name = existing.name,
    shortDescription = existing.short_description,
    description = existing.description,
    basePrice = existing.base_price,
    maxAdults = existing.max_adults,
    maxChildren = existing.max_children,
    maxOccupancy = existing.max_occupancy,
    bedType = existing.bed_type,
    sizeSqm = existing.size_sqm,
    sizeSqft = existing.size_sqft,
    heroImage = existing.hero_image,
    isFeatured = existing.is_featured
  } = req.body;

  db.prepare(`
    UPDATE room_categories
    SET name = ?, short_description = ?, description = ?, base_price = ?,
        max_adults = ?, max_children = ?, max_occupancy = ?, bed_type = ?,
        size_sqm = ?, size_sqft = ?, hero_image = ?, is_featured = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name,
    shortDescription,
    description,
    Number(basePrice),
    Number(maxAdults),
    Number(maxChildren),
    Number(maxOccupancy),
    bedType,
    Number(sizeSqm),
    Number(sizeSqft),
    heroImage,
    isFeatured ? 1 : 0,
    catId
  );

  const updated = db.prepare('SELECT * FROM room_categories WHERE id = ?').get(catId);
  logAudit({
    eventType: 'CATEGORY_UPDATED',
    entityType: 'room_category',
    entityId: updated.slug,
    actorId: req.user.id,
    actorRole: req.user.role,
    actorEmail: req.user.email,
    summary: `Updated room category "${updated.name}".`,
    details: updated,
    ipAddress: req.ip
  });

  res.json({ category: updated });
});

router.delete('/admin/categories/:id', requireRoles('manager', 'admin'), (req, res) => {
  const db = getDb();
  const catId = Number(req.params.id);
  const roomsUsing = db.prepare('SELECT COUNT(*) AS cnt FROM rooms WHERE category_id = ?').get(catId).cnt;
  if (roomsUsing > 0) {
    return res.status(400).json({
      error: 'CATEGORY_HAS_ROOMS',
      message: `Cannot delete category while ${roomsUsing} physical room(s) are assigned to it.`
    });
  }
  db.prepare('DELETE FROM room_categories WHERE id = ?').run(catId);
  res.json({ deleted: true });
});

// Admin Physical Rooms CRUD
router.post('/admin/rooms', requireRoles('manager', 'admin'), (req, res) => {
  const db = getDb();
  const {
    roomNumber,
    uniqueCode,
    name,
    categoryId,
    floor = 1,
    wing = 'Main Palace Wing',
    viewType = 'Sanctuary View',
    pricePerNight,
    maxAdults,
    maxChildren,
    maxOccupancy,
    bedType,
    sizeSqm,
    sizeSqft,
    heroImage,
    amenities,
    facilities,
    includedServices,
    checkInPolicy,
    checkOutPolicy,
    cancellationPolicy,
    refundPolicy,
    isAccessible = false,
    status = 'available'
  } = req.body;

  if (!roomNumber || !name || !categoryId) {
    return res.status(400).json({
      error: 'MISSING_ROOM_FIELDS',
      message: 'Room number, room name, and categoryId are required.'
    });
  }

  const cat = db.prepare('SELECT * FROM room_categories WHERE id = ?').get(Number(categoryId));
  if (!cat) {
    return res.status(404).json({ error: 'CATEGORY_NOT_FOUND', message: 'Selected room category does not exist.' });
  }

  const finalCode = uniqueCode || `AUR-RM-${String(roomNumber).toUpperCase()}`;

  try {
    const result = db.prepare(`
      INSERT INTO rooms (
        room_number, unique_code, name, category_id, floor, wing, view_type,
        price_per_night, max_adults, max_children, max_occupancy, bed_type,
        size_sqm, size_sqft, hero_image, gallery_json, amenities_json,
        facilities_json, included_services_json, check_in_policy, check_out_policy,
        cancellation_policy, refund_policy, is_accessible, is_sample_inventory, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      String(roomNumber).trim(),
      String(finalCode).trim(),
      String(name).trim(),
      cat.id,
      Number(floor),
      wing,
      viewType,
      Number(pricePerNight || cat.base_price),
      Number(maxAdults !== undefined ? maxAdults : cat.max_adults),
      Number(maxChildren !== undefined ? maxChildren : cat.max_children),
      Number(maxOccupancy !== undefined ? maxOccupancy : cat.max_occupancy),
      bedType || cat.bed_type,
      Number(sizeSqm || cat.size_sqm),
      Number(sizeSqft || cat.size_sqft),
      heroImage || cat.hero_image,
      cat.gallery_json,
      amenities ? JSON.stringify(Array.isArray(amenities) ? amenities : String(amenities).split(',').map((s) => s.trim()).filter(Boolean)) : cat.amenities_json,
      facilities ? JSON.stringify(Array.isArray(facilities) ? facilities : String(facilities).split(',').map((s) => s.trim()).filter(Boolean)) : cat.facilities_json,
      includedServices ? JSON.stringify(Array.isArray(includedServices) ? includedServices : String(includedServices).split(',').map((s) => s.trim()).filter(Boolean)) : cat.included_services_json,
      checkInPolicy || cat.check_in_policy,
      checkOutPolicy || cat.check_out_policy,
      cancellationPolicy || cat.cancellation_policy,
      refundPolicy || cat.refund_policy,
      isAccessible ? 1 : 0,
      status
    );

    const createdRoom = db.prepare(`
      SELECT r.*, c.name AS category_name, c.slug AS category_slug
      FROM rooms r JOIN room_categories c ON c.id = r.category_id
      WHERE r.id = ?
    `).get(Number(result.lastInsertRowid));

    logAudit({
      eventType: 'ROOM_CREATED',
      entityType: 'room',
      entityId: createdRoom.room_number,
      actorId: req.user.id,
      actorRole: req.user.role,
      actorEmail: req.user.email,
      summary: `Added physical room #${createdRoom.room_number} (${createdRoom.name}) at $${createdRoom.price_per_night}/night.`,
      details: createdRoom,
      ipAddress: req.ip
    });

    res.status(201).json({ room: formatRoomRecord(createdRoom) });
  } catch (err) {
    res.status(400).json({ error: 'ROOM_CREATE_FAILED', message: err.message });
  }
});

router.put('/admin/rooms/:id', requireRoles('manager', 'admin'), (req, res) => {
  const db = getDb();
  const roomId = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!existing) {
    return res.status(404).json({ error: 'ROOM_NOT_FOUND', message: 'Room not found.' });
  }

  const {
    roomNumber = existing.room_number,
    name = existing.name,
    categoryId = existing.category_id,
    floor = existing.floor,
    wing = existing.wing,
    viewType = existing.view_type,
    pricePerNight = existing.price_per_night,
    maxAdults = existing.max_adults,
    maxChildren = existing.max_children,
    maxOccupancy = existing.max_occupancy,
    bedType = existing.bed_type,
    sizeSqm = existing.size_sqm,
    sizeSqft = existing.size_sqft,
    heroImage = existing.hero_image,
    status = existing.status,
    notes = existing.notes
  } = req.body;

  db.prepare(`
    UPDATE rooms
    SET room_number = ?, name = ?, category_id = ?, floor = ?, wing = ?, view_type = ?,
        price_per_night = ?, max_adults = ?, max_children = ?, max_occupancy = ?,
        bed_type = ?, size_sqm = ?, size_sqft = ?, hero_image = ?, status = ?, notes = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    String(roomNumber).trim(),
    String(name).trim(),
    Number(categoryId),
    Number(floor),
    wing,
    viewType,
    Number(pricePerNight),
    Number(maxAdults),
    Number(maxChildren),
    Number(maxOccupancy),
    bedType,
    Number(sizeSqm),
    Number(sizeSqft),
    heroImage,
    status,
    notes,
    roomId
  );

  const updated = db.prepare(`
    SELECT r.*, c.name AS category_name, c.slug AS category_slug
    FROM rooms r JOIN room_categories c ON c.id = r.category_id
    WHERE r.id = ?
  `).get(roomId);

  logAudit({
    eventType: 'ROOM_UPDATED',
    entityType: 'room',
    entityId: updated.room_number,
    actorId: req.user.id,
    actorRole: req.user.role,
    actorEmail: req.user.email,
    summary: `Updated room #${updated.room_number} (${updated.name}) — status: ${updated.status}, price: $${updated.price_per_night}.`,
    details: updated,
    ipAddress: req.ip
  });

  res.json({ room: formatRoomRecord(updated) });
});

router.delete('/admin/rooms/:id', requireRoles('manager', 'admin'), (req, res) => {
  const db = getDb();
  const roomId = Number(req.params.id);
  const activeResCount = db.prepare(`
    SELECT COUNT(*) AS cnt FROM reservation_rooms WHERE room_id = ? AND status = 'active'
  `).get(roomId).cnt;

  if (activeResCount > 0) {
    return res.status(400).json({
      error: 'ROOM_HAS_ACTIVE_RESERVATIONS',
      message: 'Cannot remove a physical room that has active confirmed reservations. Cancel or reassign reservations first.'
    });
  }

  db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
  logAudit({
    eventType: 'ROOM_DELETED',
    entityType: 'room',
    entityId: String(roomId),
    actorId: req.user.id,
    actorRole: req.user.role,
    actorEmail: req.user.email,
    summary: `Deleted physical room ID ${roomId}.`,
    ipAddress: req.ip
  });
  res.json({ deleted: true });
});

// Maintenance Blocks & Availability Calendar
router.get('/admin/tape-chart', requireRoles('receptionist', 'finance', 'manager', 'admin'), (req, res) => {
  const tapeChart = getFrontDeskTapeChart({
    startDate: req.query.startDate || null,
    days: Number(req.query.days || 14)
  });
  res.json(tapeChart);
});

router.patch('/admin/rooms/:id/housekeeping', requireRoles('receptionist', 'manager', 'admin'), (req, res) => {
  const { housekeepingStatus } = req.body;
  const validStatuses = ['clean_inspected', 'turndown_complete', 'dirty_turnover', 'deep_cleaning'];
  if (!validStatuses.includes(housekeepingStatus)) {
    return res.status(400).json({
      error: 'INVALID_HOUSEKEEPING_STATUS',
      message: `housekeepingStatus must be one of: ${validStatuses.join(', ')}`
    });
  }

  const db = getDb();
  const roomId = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!existing) {
    return res.status(404).json({ error: 'ROOM_NOT_FOUND', message: 'Room not found.' });
  }

  db.prepare(`
    UPDATE rooms
    SET housekeeping_status = ?, housekeeping_updated_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(housekeepingStatus, roomId);

  const updated = db.prepare(`
    SELECT r.*, c.name AS category_name, c.slug AS category_slug
    FROM rooms r JOIN room_categories c ON c.id = r.category_id
    WHERE r.id = ?
  `).get(roomId);

  logAudit({
    eventType: 'HOUSEKEEPING_STATUS_UPDATED',
    entityType: 'room',
    entityId: updated.room_number,
    actorId: req.user.id,
    actorRole: req.user.role,
    actorEmail: req.user.email,
    summary: `Updated Room #${updated.room_number} housekeeping status to ${housekeepingStatus}.`,
    details: { roomId, roomNumber: updated.room_number, housekeepingStatus },
    ipAddress: req.ip
  });

  res.json({ room: formatRoomRecord(updated) });
});

router.get('/admin/calendar', requireRoles('receptionist', 'finance', 'manager', 'admin'), (req, res) => {
  releaseExpiredHolds();
  const db = getDb();
  const rooms = db.prepare(`
    SELECT r.id, r.room_number, r.unique_code, r.name, r.status, r.housekeeping_status, r.price_per_night, c.name AS category_name
    FROM rooms r
    JOIN room_categories c ON c.id = r.category_id
    ORDER BY c.sort_order ASC, r.room_number ASC
  `).all();

  const reservations = db.prepare(`
    SELECT rr.*, res.booking_reference, res.guest_first_name, res.guest_last_name, res.status AS reservation_status, res.payment_status
    FROM reservation_rooms rr
    JOIN reservations res ON res.id = rr.reservation_id
    WHERE rr.status = 'active' AND res.status != 'cancelled'
    ORDER BY rr.check_in ASC
  `).all();

  const maintenanceBlocks = db.prepare(`
    SELECT mb.*, r.room_number, r.name AS room_name
    FROM maintenance_blocks mb
    JOIN rooms r ON r.id = mb.room_id
    WHERE mb.status = 'active'
    ORDER BY mb.start_date ASC
  `).all();

  const activeHolds = db.prepare(`
    SELECT rh.*, r.room_number, r.name AS room_name
    FROM room_holds rh
    JOIN rooms r ON r.id = rh.room_id
    WHERE rh.status = 'ACTIVE' AND rh.expires_at > datetime('now')
    ORDER BY rh.check_in ASC
  `).all();

  res.json({
    rooms,
    reservations,
    maintenanceBlocks,
    activeHolds
  });
});

router.post('/admin/maintenance', requireRoles('receptionist', 'manager', 'admin'), (req, res) => {
  const { roomId, startDate, endDate, reason = 'Scheduled Maintenance & Sanctuary Refurbishment' } = req.body;
  if (!roomId || !startDate || !endDate) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'roomId, startDate, and endDate are required.' });
  }

  const db = getDb();
  try {
    const result = db.prepare(`
      INSERT INTO maintenance_blocks (room_id, start_date, end_date, reason, created_by, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(Number(roomId), startDate, endDate, reason, `${req.user.first_name} ${req.user.last_name}`);

    const block = db.prepare('SELECT * FROM maintenance_blocks WHERE id = ?').get(Number(result.lastInsertRowid));
    logAudit({
      eventType: 'MAINTENANCE_BLOCK_CREATED',
      entityType: 'maintenance_block',
      entityId: String(block.id),
      actorId: req.user.id,
      actorRole: req.user.role,
      actorEmail: req.user.email,
      summary: `Blocked room ID ${roomId} for maintenance (${startDate} to ${endDate}): ${reason}`,
      details: block,
      ipAddress: req.ip
    });

    res.status(201).json({ maintenanceBlock: block });
  } catch (err) {
    res.status(409).json({
      error: 'MAINTENANCE_BLOCK_CONFLICT',
      message: err.message
    });
  }
});

router.delete('/admin/maintenance/:id', requireRoles('receptionist', 'manager', 'admin'), (req, res) => {
  const db = getDb();
  db.prepare("UPDATE maintenance_blocks SET status = 'cancelled' WHERE id = ?").run(Number(req.params.id));
  logAudit({
    eventType: 'MAINTENANCE_BLOCK_REMOVED',
    entityType: 'maintenance_block',
    entityId: String(req.params.id),
    actorId: req.user.id,
    actorRole: req.user.role,
    actorEmail: req.user.email,
    summary: `Removed maintenance block ID ${req.params.id}.`,
    ipAddress: req.ip
  });
  res.json({ cancelled: true });
});

// InboundIcalChannelSyncModule Endpoint
router.post('/admin/rooms/:id/ical-import', requireRoles('manager', 'admin'), (req, res) => {
  try {
    const result = importRoomIcalFeed({
      roomId: Number(req.params.id),
      icsContent: req.body.icsContent,
      channelName: req.body.channelName || 'External Luxury Desk / OTA',
      createdBy: `${req.user.first_name} ${req.user.last_name} (${req.user.role})`,
      ipAddress: req.ip
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.code || 'ICAL_IMPORT_FAILED', message: err.message });
  }
});

// Admin Reservations, Walk-In Creation, Check-In/Out, Payment Confirmation & Refunds
router.get('/admin/reservations', requireRoles('receptionist', 'finance', 'manager', 'admin'), (req, res) => {
  const db = getDb();
  let sql = 'SELECT booking_reference FROM reservations WHERE 1=1';
  const params = [];

  if (req.query.status && req.query.status !== 'all') {
    sql += ' AND status = ?';
    params.push(req.query.status);
  }
  if (req.query.search) {
    sql += ' AND (booking_reference LIKE ? OR guest_email LIKE ? OR guest_last_name LIKE ? OR guest_first_name LIKE ?)';
    const q = `%${req.query.search}%`;
    params.push(q, q, q, q);
  }
  sql += ' ORDER BY id DESC LIMIT 100';

  const refs = db.prepare(sql).all(...params);
  const reservations = refs.map((r) => getReservationByReference(r.booking_reference));
  res.json({ reservations });
});

router.post('/admin/reservations/walk-in', requireRoles('receptionist', 'manager', 'admin'), (req, res) => {
  try {
    const {
      roomIds,
      roomId,
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
      paymentMethod = 'pay_at_hotel',
      paymentPlan = 'full'
    } = req.body;

    const ids = Array.isArray(roomIds) ? roomIds : roomId ? [roomId] : [];
    const reservation = confirmReservation({
      roomIds: ids,
      checkIn,
      checkOut,
      adults,
      children,
      guestFirstName,
      guestLastName,
      guestEmail,
      guestPhone,
      guestCountry,
      specialRequests,
      selectedAddons,
      promoCode,
      paymentMethod,
      paymentPlan,
      paymentToken: 'tok_staff_authorised',
      bankReference: 'STAFF-WALKIN-VERIFIED',
      bookingSource: 'walk_in',
      bookedByStaffId: req.user.id,
      ipAddress: req.ip
    });

    res.status(201).json({ reservation });
  } catch (err) {
    res.status(400).json({ error: err.code || 'WALKIN_FAILED', message: err.message });
  }
});

router.post('/admin/reservations/:bookingReference/status', requireRoles('receptionist', 'manager', 'admin'), (req, res) => {
  const { status } = req.body;
  if (!['confirmed', 'checked_in', 'checked_out'].includes(status)) {
    return res.status(400).json({ error: 'INVALID_STATUS', message: 'Status must be confirmed, checked_in, or checked_out.' });
  }

  const existing = getReservationByReference(req.params.bookingReference);
  if (!existing) {
    return res.status(404).json({ error: 'RESERVATION_NOT_FOUND', message: 'Reservation not found.' });
  }

  const db = getDb();

  // Enforce Housekeeping Readiness before allowing guest Check-In
  if (status === 'checked_in') {
    const unreadyRooms = (existing.rooms || []).filter(
      (rm) => !['clean_inspected', 'turndown_complete'].includes(rm.housekeeping_status || 'clean_inspected')
    );
    if (unreadyRooms.length > 0) {
      const listStr = unreadyRooms.map((r) => `#${r.room_number} (${r.housekeeping_status})`).join(', ');
      return res.status(409).json({
        error: 'HOUSEKEEPING_NOT_READY',
        message: `Cannot check in guest until housekeeping marks room(s) ${listStr} as Clean & Inspected.`
      });
    }
  }

  db.prepare("UPDATE reservations SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, existing.id);

  // When checking out, automatically transition physical rooms to 'dirty_turnover' for housekeeping
  if (status === 'checked_out') {
    const markDirty = db.prepare("UPDATE rooms SET housekeeping_status = 'dirty_turnover', housekeeping_updated_at = datetime('now') WHERE id = ?");
    for (const rm of existing.rooms || []) {
      markDirty.run(rm.room_id);
    }
  }

  logAudit({
    eventType: `RESERVATION_${status.toUpperCase()}`,
    entityType: 'reservation',
    entityId: existing.booking_reference,
    actorId: req.user.id,
    actorRole: req.user.role,
    actorEmail: req.user.email,
    summary: `Updated reservation ${existing.booking_reference} status to ${status}.`,
    ipAddress: req.ip
  });

  res.json({ reservation: getReservationByReference(existing.booking_reference) });
});

router.post('/admin/reservations/:bookingReference/folio', requireRoles('receptionist', 'finance', 'manager', 'admin'), (req, res) => {
  try {
    const updated = addFolioCharge({
      bookingReference: req.params.bookingReference,
      category: req.body.category || 'In-Suite Dining',
      description: req.body.description,
      unitPrice: req.body.unitPrice,
      quantity: req.body.quantity || 1,
      postedBy: `${req.user.first_name} ${req.user.last_name} (${req.user.role})`,
      actorId: req.user.id,
      actorRole: req.user.role,
      actorEmail: req.user.email,
      ipAddress: req.ip
    });
    res.status(201).json({ reservation: updated });
  } catch (err) {
    res.status(400).json({ error: err.code || 'FOLIO_POST_FAILED', message: err.message });
  }
});

router.delete('/admin/reservations/:bookingReference/folio/:chargeId', requireRoles('finance', 'manager', 'admin'), (req, res) => {
  try {
    const updated = removeFolioCharge({
      bookingReference: req.params.bookingReference,
      chargeId: Number(req.params.chargeId),
      actorId: req.user.id,
      actorRole: req.user.role,
      actorEmail: req.user.email,
      ipAddress: req.ip
    });
    res.json({ reservation: updated });
  } catch (err) {
    res.status(400).json({ error: err.code || 'FOLIO_DELETE_FAILED', message: err.message });
  }
});

router.post('/admin/reservations/:bookingReference/confirm-payment', requireRoles('finance', 'manager', 'admin', 'receptionist'), (req, res) => {
  const existing = getReservationByReference(req.params.bookingReference);
  if (!existing) {
    return res.status(404).json({ error: 'RESERVATION_NOT_FOUND', message: 'Reservation not found.' });
  }

  const remainingBalance = roundMoney(Math.max(0, existing.grandFolioTotal - existing.amount_paid));
  const amountToRecord = req.body.amount !== undefined ? roundMoney(Number(req.body.amount)) : remainingBalance;

  if (amountToRecord <= 0) {
    return res.status(400).json({ error: 'ALREADY_PAID', message: 'Reservation & folio balance is already paid in full.' });
  }

  const db = getDb();
  const newPaid = roundMoney(existing.amount_paid + amountToRecord);
  const newPaymentStatus = newPaid >= existing.grandFolioTotal ? 'paid' : 'deposit_paid';
  const payRef = generatePaymentReference('STF');
  const invNum = generateInvoiceNumber();

  db.prepare(`
    UPDATE reservations
    SET amount_paid = ?, payment_status = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(newPaid, newPaymentStatus, existing.id);

  db.prepare(`
    INSERT INTO payments (
      payment_reference, invoice_number, reservation_id, booking_reference,
      amount, currency, display_currency, display_amount,
      payment_method, payment_type, status, gateway_response_json, verified_at
    ) VALUES (?, ?, ?, ?, ?, 'USD', ?, ?, ?, 'balance', 'succeeded', ?, datetime('now'))
  `).run(
    payRef,
    invNum,
    existing.id,
    existing.booking_reference,
    amountToRecord,
    existing.currency,
    roundMoney(amountToRecord * existing.exchange_rate),
    req.body.paymentMethod || existing.payment_method,
    JSON.stringify({ verifiedByStaff: req.user.email, amountToRecord })
  );

  sendNotification({
    templateCode: 'PAYMENT_RECEIPT',
    reservationId: existing.id,
    userId: existing.user_id,
    recipientEmail: existing.guest_email,
    recipientPhone: existing.guest_phone,
    variables: {
      guest_name: `${existing.guest_first_name} ${existing.guest_last_name}`,
      booking_reference: existing.booking_reference,
      invoice_number: invNum,
      payment_reference: payRef,
      amount_formatted: `$${amountToRecord.toFixed(2)} USD`,
      payment_method: (req.body.paymentMethod || existing.payment_method).toUpperCase()
    }
  });

  logAudit({
    eventType: 'STAFF_PAYMENT_CONFIRMED',
    entityType: 'reservation',
    entityId: existing.booking_reference,
    actorId: req.user.id,
    actorRole: req.user.role,
    actorEmail: req.user.email,
    summary: `Confirmed payment of $${amountToRecord.toFixed(2)} USD for reservation ${existing.booking_reference} (Ref: ${payRef}).`,
    ipAddress: req.ip
  });

  res.json({ reservation: getReservationByReference(existing.booking_reference) });
});

router.post('/admin/reservations/:bookingReference/refund', requireRoles('finance', 'manager', 'admin'), (req, res) => {
  const existing = getReservationByReference(req.params.bookingReference);
  if (!existing) {
    return res.status(404).json({ error: 'RESERVATION_NOT_FOUND', message: 'Reservation not found.' });
  }

  const maxRefundable = roundMoney(Math.max(0, existing.amount_paid - existing.refunded_amount));
  const refundAmount = req.body.amount !== undefined ? roundMoney(Number(req.body.amount)) : maxRefundable;

  if (refundAmount <= 0 || refundAmount > maxRefundable) {
    return res.status(400).json({
      error: 'INVALID_REFUND_AMOUNT',
      message: `Refund amount must be between $0.01 and $${maxRefundable.toFixed(2)}.`
    });
  }

  const db = getDb();
  const newRefundedTotal = roundMoney(existing.refunded_amount + refundAmount);
  const newStatus = newRefundedTotal >= existing.amount_paid ? 'refunded' : 'partially_refunded';
  const refundRef = generatePaymentReference('RFD');

  db.prepare(`
    UPDATE reservations
    SET refunded_amount = ?, payment_status = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(newRefundedTotal, newStatus, existing.id);

  db.prepare(`
    INSERT INTO payments (
      payment_reference, invoice_number, reservation_id, booking_reference,
      amount, currency, display_currency, display_amount,
      payment_method, payment_type, status, gateway_response_json, verified_at
    ) VALUES (?, ?, ?, ?, ?, 'USD', ?, ?, ?, 'refund', 'refunded', ?, datetime('now'))
  `).run(
    refundRef,
    generateInvoiceNumber(),
    existing.id,
    existing.booking_reference,
    -refundAmount,
    existing.currency,
    roundMoney(-refundAmount * existing.exchange_rate),
    existing.payment_method,
    JSON.stringify({ authorisedBy: req.user.email, reason: req.body.reason || 'Authorised refund' })
  );

  sendNotification({
    templateCode: 'REFUND_PROCESSED',
    reservationId: existing.id,
    userId: existing.user_id,
    recipientEmail: existing.guest_email,
    recipientPhone: existing.guest_phone,
    variables: {
      guest_name: `${existing.guest_first_name} ${existing.guest_last_name}`,
      booking_reference: existing.booking_reference,
      refund_formatted: `$${refundAmount.toFixed(2)} USD`,
      payment_reference: refundRef
    }
  });

  logAudit({
    eventType: 'REFUND_ISSUED',
    entityType: 'reservation',
    entityId: existing.booking_reference,
    actorId: req.user.id,
    actorRole: req.user.role,
    actorEmail: req.user.email,
    summary: `Issued refund of $${refundAmount.toFixed(2)} USD for ${existing.booking_reference} (Ref: ${refundRef}).`,
    ipAddress: req.ip
  });

  res.json({
    refundReference: refundRef,
    refundAmount,
    reservation: getReservationByReference(existing.booking_reference)
  });
});

// Seasonal Rates & Promo Codes Management
router.post('/admin/seasonal-rates', requireRoles('finance', 'manager', 'admin'), (req, res) => {
  const { name, categoryId = null, startDate, endDate, multiplier = 1.2, badgeText = '' } = req.body;
  if (!name || !startDate || !endDate) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'name, startDate, and endDate are required.' });
  }
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO seasonal_rates (name, category_id, start_date, end_date, multiplier, badge_text, is_active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(name, categoryId ? Number(categoryId) : null, startDate, endDate, Number(multiplier), badgeText || `${name} (${Math.round((Number(multiplier) - 1) * 100)}%)`);

  res.status(201).json({
    seasonalRate: db.prepare('SELECT * FROM seasonal_rates WHERE id = ?').get(Number(result.lastInsertRowid))
  });
});

router.delete('/admin/seasonal-rates/:id', requireRoles('finance', 'manager', 'admin'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM seasonal_rates WHERE id = ?').run(Number(req.params.id));
  res.json({ deleted: true });
});

router.post('/admin/promo-codes', requireRoles('finance', 'manager', 'admin'), (req, res) => {
  const {
    code,
    description,
    discountType = 'percent',
    discountValue = 10,
    minNights = 1,
    minAmount = 0,
    validFrom = '2026-01-01',
    validUntil = '2027-12-31'
  } = req.body;

  if (!code || !description) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Promo code and description are required.' });
  }

  const db = getDb();
  try {
    const result = db.prepare(`
      INSERT INTO promo_codes (code, description, discount_type, discount_value, min_nights, min_amount, valid_from, valid_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(String(code).trim().toUpperCase(), description, discountType, Number(discountValue), Number(minNights), Number(minAmount), validFrom, validUntil);

    res.status(201).json({
      promoCode: db.prepare('SELECT * FROM promo_codes WHERE id = ?').get(Number(result.lastInsertRowid))
    });
  } catch (err) {
    res.status(400).json({ error: 'PROMO_CREATE_FAILED', message: err.message });
  }
});

router.delete('/admin/promo-codes/:id', requireRoles('finance', 'manager', 'admin'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM promo_codes WHERE id = ?').run(Number(req.params.id));
  res.json({ deleted: true });
});

// Hotel Settings Configuration (including DynamicYieldPricingModule)
router.put('/admin/settings', requireRoles('finance', 'manager', 'admin'), (req, res) => {
  const db = getDb();
  const current = getHotelSettings();

  const {
    hotelName = current.hotel_name,
    environmentMode = current.environment_mode,
    environmentBanner = current.environment_banner,
    timezone = current.timezone,
    checkInTime = current.check_in_time,
    checkOutTime = current.check_out_time,
    sameDayTurnover = current.same_day_turnover,
    taxRatePercent = current.tax_rate_percent,
    serviceFeePercent = current.service_fee_percent,
    cityLevyPerNight = current.city_levy_per_night,
    depositPercent = current.deposit_percent,
    holdDurationMinutes = current.hold_duration_minutes,
    freeCancellationHours = current.free_cancellation_hours,
    lateCancellationPenaltyPercent = current.late_cancellation_penalty_percent,
    allowPayAtHotel = current.allow_pay_at_hotel,
    dynamicYieldEnabled = current.dynamic_yield_enabled,
    highDemandOccupancyThreshold = current.high_demand_occupancy_threshold,
    highDemandMultiplier = current.high_demand_multiplier
  } = req.body;

  db.prepare(`
    UPDATE hotel_settings
    SET hotel_name = ?, environment_mode = ?, environment_banner = ?, timezone = ?,
        check_in_time = ?, check_out_time = ?, same_day_turnover = ?,
        tax_rate_percent = ?, service_fee_percent = ?, city_levy_per_night = ?,
        deposit_percent = ?, hold_duration_minutes = ?, free_cancellation_hours = ?,
        late_cancellation_penalty_percent = ?, allow_pay_at_hotel = ?,
        dynamic_yield_enabled = ?, high_demand_occupancy_threshold = ?, high_demand_multiplier = ?,
        updated_at = datetime('now')
    WHERE id = 1
  `).run(
    hotelName,
    environmentMode,
    environmentBanner,
    timezone,
    checkInTime,
    checkOutTime,
    sameDayTurnover ? 1 : 0,
    Number(taxRatePercent),
    Number(serviceFeePercent),
    Number(cityLevyPerNight),
    Number(depositPercent),
    Number(holdDurationMinutes),
    Number(freeCancellationHours),
    Number(lateCancellationPenaltyPercent),
    allowPayAtHotel ? 1 : 0,
    dynamicYieldEnabled ? 1 : 0,
    Number(highDemandOccupancyThreshold ?? 75.0),
    Number(highDemandMultiplier ?? 1.15)
  );

  const updated = getHotelSettings();
  logAudit({
    eventType: 'SETTINGS_UPDATED',
    entityType: 'hotel_settings',
    entityId: '1',
    actorId: req.user.id,
    actorRole: req.user.role,
    actorEmail: req.user.email,
    summary: `Updated hotel policies and tax/deposit settings.`,
    details: updated,
    ipAddress: req.ip
  });

  res.json({ settings: updated });
});

// Staff & Users Management (Admin & Manager)
router.get('/admin/users', requireRoles('manager', 'admin'), (req, res) => {
  const db = getDb();
  let sql = `
    SELECT
      u.id, u.email, u.first_name, u.last_name, u.phone, u.country,
      u.role, u.loyalty_tier, u.loyalty_points, u.is_active, u.created_at,
      COUNT(r.id) AS total_bookings,
      COALESCE(SUM(CASE WHEN r.status != 'cancelled' THEN r.total_amount ELSE 0 END), 0) AS lifetime_spend_usd
    FROM users u
    LEFT JOIN reservations r ON (r.user_id = u.id OR LOWER(r.guest_email) = LOWER(u.email))
    WHERE 1=1
  `;
  const params = [];
  if (req.query.role && req.query.role !== 'all') {
    sql += ' AND u.role = ?';
    params.push(req.query.role);
  }
  if (req.query.search) {
    const q = `%${req.query.search}%`;
    sql += ' AND (u.email LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ?)';
    params.push(q, q, q);
  }
  sql += ' GROUP BY u.id ORDER BY u.id ASC';

  const users = db.prepare(sql).all(...params);
  res.json({ users });
});

router.post('/admin/users', requireRoles('admin'), (req, res) => {
  const {
    email,
    password = 'AureliaUser!2026',
    firstName,
    lastName,
    phone = '',
    country = 'Switzerland',
    role = 'guest',
    loyaltyTier = 'Aurélia Privé',
    loyaltyPoints = 1000
  } = req.body;

  if (!email || !firstName || !lastName) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'email, firstName, and lastName are required.' });
  }
  const validRoles = ['guest', 'receptionist', 'finance', 'manager', 'admin'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: 'INVALID_ROLE', message: 'Invalid role specified.' });
  }

  const db = getDb();
  const cleanEmail = String(email).trim().toLowerCase();
  if (db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(cleanEmail)) {
    return res.status(409).json({ error: 'EMAIL_ALREADY_EXISTS', message: 'A user with that email already exists.' });
  }

  const { salt, hash } = hashPassword(String(password));
  const result = db.prepare(`
    INSERT INTO users (
      email, password_hash, password_salt, first_name, last_name,
      phone, country, role, loyalty_tier, loyalty_points, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    cleanEmail,
    hash,
    salt,
    String(firstName).trim(),
    String(lastName).trim(),
    String(phone).trim(),
    String(country).trim(),
    role,
    String(loyaltyTier).trim(),
    Number(loyaltyPoints || 0)
  );

  const created = db.prepare(`
    SELECT id, email, first_name, last_name, phone, country, role, loyalty_tier, loyalty_points, is_active, created_at
    FROM users WHERE id = ?
  `).get(Number(result.lastInsertRowid));

  logAudit({
    eventType: 'ADMIN_USER_CREATED',
    entityType: 'user',
    entityId: String(created.id),
    actorId: req.user.id,
    actorRole: req.user.role,
    actorEmail: req.user.email,
    summary: `Admin created user ${created.email} with role ${created.role} (${created.loyalty_tier}, ${created.loyalty_points} pts).`,
    ipAddress: req.ip
  });

  res.status(201).json({ user: created });
});

router.put('/admin/users/:id', requireRoles('manager', 'admin'), (req, res) => {
  const db = getDb();
  const targetId = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!existing) {
    return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'User not found.' });
  }

  const {
    firstName = existing.first_name,
    lastName = existing.last_name,
    phone = existing.phone,
    country = existing.country,
    role = existing.role,
    loyaltyTier = existing.loyalty_tier,
    loyaltyPoints = existing.loyalty_points,
    isActive = Boolean(existing.is_active)
  } = req.body;

  // Only full admin can change RBAC roles
  const finalRole = req.user.role === 'admin' ? role : existing.role;

  db.prepare(`
    UPDATE users
    SET first_name = ?, last_name = ?, phone = ?, country = ?,
        role = ?, loyalty_tier = ?, loyalty_points = ?, is_active = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    String(firstName).trim(),
    String(lastName).trim(),
    String(phone).trim(),
    String(country).trim(),
    finalRole,
    String(loyaltyTier).trim(),
    Math.max(0, Number(loyaltyPoints || 0)),
    isActive ? 1 : 0,
    targetId
  );

  const updated = db.prepare(`
    SELECT id, email, first_name, last_name, phone, country, role, loyalty_tier, loyalty_points, is_active, created_at
    FROM users WHERE id = ?
  `).get(targetId);

  logAudit({
    eventType: 'ADMIN_USER_UPDATED',
    entityType: 'user',
    entityId: String(targetId),
    actorId: req.user.id,
    actorRole: req.user.role,
    actorEmail: req.user.email,
    summary: `Updated user ${updated.email} (Role: ${updated.role}, Tier: ${updated.loyalty_tier}, Points: ${updated.loyalty_points}, Active: ${updated.is_active}).`,
    ipAddress: req.ip
  });

  res.json({ user: updated });
});

router.delete('/admin/users/:id', requireRoles('admin'), (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'CANNOT_DELETE_SELF', message: 'You cannot delete your own active admin account.' });
  }
  const db = getDb();
  const existing = db.prepare('SELECT email FROM users WHERE id = ?').get(targetId);
  if (!existing) {
    return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'User not found.' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  logAudit({
    eventType: 'ADMIN_USER_DELETED',
    entityType: 'user',
    entityId: String(targetId),
    actorId: req.user.id,
    actorRole: req.user.role,
    actorEmail: req.user.email,
    summary: `Deleted user account ${existing.email} (ID ${targetId}).`,
    ipAddress: req.ip
  });
  res.json({ deleted: true });
});

// Admin VIP Concierge Service Desk Endpoints
router.get('/admin/concierge-requests', requireRoles('receptionist', 'manager', 'admin'), (_req, res) => {
  const db = getDb();
  const requests = db.prepare('SELECT * FROM concierge_requests ORDER BY id DESC LIMIT 100').all();
  res.json({ conciergeRequests: requests });
});

router.patch('/admin/concierge-requests/:id', requireRoles('receptionist', 'manager', 'admin'), (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM concierge_requests WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'REQUEST_NOT_FOUND', message: 'Concierge request not found.' });
  }

  const validStatuses = ['pending', 'in_progress', 'fulfilled', 'cancelled'];
  const newStatus = validStatuses.includes(req.body.status) ? req.body.status : existing.status;
  const staffNotes = req.body.staffNotes !== undefined ? String(req.body.staffNotes).trim() : existing.staff_notes;
  const handledBy = `${req.user.first_name} ${req.user.last_name} (${req.user.role})`;

  db.prepare(`
    UPDATE concierge_requests
    SET status = ?, staff_notes = ?, handled_by = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(newStatus, staffNotes, handledBy, id);

  const updated = db.prepare('SELECT * FROM concierge_requests WHERE id = ?').get(id);

  db.prepare(`
    INSERT INTO notifications (
      user_id, recipient_email, channel, template_code, subject, body, status
    ) VALUES (?, ?, 'email', 'CONCIERGE_UPDATE', ?, ?, 'sent')
  `).run(
    existing.user_id || null,
    existing.guest_email,
    `Maison Aurélia Concierge Desk Update — ${existing.request_reference} (${newStatus.toUpperCase()})`,
    `Dear ${existing.guest_name}, your concierge request "${existing.subject}" (${existing.request_reference}) is now ${newStatus.toUpperCase()}. Concierge Notes: ${staffNotes || 'Arranged with pleasure by our Palace Concierge Desk.'}`
  );

  logAudit({
    eventType: 'CONCIERGE_REQUEST_UPDATED',
    entityType: 'concierge_request',
    entityId: existing.request_reference,
    actorId: req.user.id,
    actorRole: req.user.role,
    actorEmail: req.user.email,
    summary: `Updated concierge request ${existing.request_reference} to ${newStatus}.`,
    ipAddress: req.ip
  });

  res.json({ conciergeRequest: updated });
});

// Admin Financial Payments & Refunds Ledger
router.get('/admin/payments', requireRoles('finance', 'manager', 'admin'), (_req, res) => {
  const db = getDb();
  const payments = db.prepare(`
    SELECT p.*, r.guest_first_name, r.guest_last_name, r.guest_email
    FROM payments p
    LEFT JOIN reservations r ON r.id = p.reservation_id
    ORDER BY p.id DESC LIMIT 100
  `).all();
  res.json({ payments });
});

router.patch('/admin/users/:id/role', requireRoles('admin'), (req, res) => {
  const { role, isActive } = req.body;
  const validRoles = ['guest', 'receptionist', 'finance', 'manager', 'admin'];
  if (role && !validRoles.includes(role)) {
    return res.status(400).json({ error: 'INVALID_ROLE', message: 'Invalid role specified.' });
  }

  const db = getDb();
  const targetId = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!existing) {
    return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'User not found.' });
  }

  db.prepare(`
    UPDATE users
    SET role = ?, is_active = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(role || existing.role, isActive !== undefined ? (isActive ? 1 : 0) : existing.is_active, targetId);

  logAudit({
    eventType: 'USER_ROLE_UPDATED',
    entityType: 'user',
    entityId: String(targetId),
    actorId: req.user.id,
    actorRole: req.user.role,
    actorEmail: req.user.email,
    summary: `Updated user ${existing.email} role to ${role || existing.role}.`,
    ipAddress: req.ip
  });

  res.json({
    user: db.prepare('SELECT id, email, first_name, last_name, role, is_active FROM users WHERE id = ?').get(targetId)
  });
});

// Notification Templates Management
router.get('/admin/templates', requireRoles('manager', 'admin'), (req, res) => {
  const db = getDb();
  const templates = db.prepare('SELECT * FROM notification_templates ORDER BY id ASC').all();
  const recentNotifications = db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 30').all();
  res.json({ templates, recentNotifications });
});

router.put('/admin/templates/:code', requireRoles('manager', 'admin'), (req, res) => {
  const { subjectTemplate, bodyTemplate, channel = 'email' } = req.body;
  const db = getDb();
  db.prepare(`
    UPDATE notification_templates
    SET subject_template = ?, body_template = ?, channel = ?, updated_at = datetime('now')
    WHERE code = ?
  `).run(subjectTemplate, bodyTemplate, channel, req.params.code);

  res.json({
    template: db.prepare('SELECT * FROM notification_templates WHERE code = ?').get(req.params.code)
  });
});

// Audit Logs, Reports Export & Backup
router.get('/admin/audit-logs', requireRoles('finance', 'manager', 'admin'), (req, res) => {
  const logs = getAuditLogs({
    limit: req.query.limit || 100,
    eventType: req.query.eventType || null
  });
  res.json({ auditLogs: logs });
});

router.get('/admin/reports/export', requireRoles('finance', 'manager', 'admin'), (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      booking_reference, guest_first_name, guest_last_name, guest_email,
      check_in, check_out, nights, rooms_count, status, payment_status,
      payment_method, payment_plan, total_amount, amount_paid, refunded_amount, created_at
    FROM reservations
    ORDER BY id DESC
  `).all();

  if (req.query.format === 'csv') {
    const headers = [
      'booking_reference', 'guest_first_name', 'guest_last_name', 'guest_email',
      'check_in', 'check_out', 'nights', 'rooms_count', 'status', 'payment_status',
      'payment_method', 'payment_plan', 'total_amount', 'amount_paid', 'refunded_amount', 'created_at'
    ];
    const csvLines = [
      headers.join(','),
      ...rows.map((r) =>
        headers.map((h) => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(',')
      )
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="maison-aurelia-reservations-report.csv"');
    return res.send(csvLines.join('\n'));
  }

  res.json({ exportedAt: new Date().toISOString(), count: rows.length, reservations: rows });
});

router.post('/admin/backup', requireRoles('admin'), (req, res) => {
  try {
    const info = backupDatabase();
    logAudit({
      eventType: 'DATABASE_BACKUP_CREATED',
      entityType: 'database',
      entityId: info.backupPath,
      actorId: req.user.id,
      actorRole: req.user.role,
      actorEmail: req.user.email,
      summary: `Created database backup snapshot (${info.sizeBytes} bytes).`,
      details: info,
      ipAddress: req.ip
    });
    res.json({ backup: info });
  } catch (err) {
    res.status(500).json({ error: 'BACKUP_FAILED', message: err.message });
  }
});

// ExternalCloudNotificationAndGatewayAdapters Endpoints
router.get('/admin/integrations', requireRoles('finance', 'manager', 'admin'), (_req, res) => {
  res.json(getCloudAdapterStatus());
});

router.post('/admin/integrations/test', requireRoles('manager', 'admin'), (req, res) => {
  try {
    const result = testCloudAdapterHandshake({
      adapterId: req.body.adapterId || req.body.provider,
      testRecipient: req.body.testRecipient || req.user.email,
      actorId: req.user.id,
      actorRole: req.user.role,
      actorEmail: req.user.email,
      ipAddress: req.ip
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.code || 'ADAPTER_TEST_FAILED', message: err.message });
  }
});

// 1. AutomatedWaitlistAndRoomAlertModule Endpoints
router.post('/waitlist', (req, res) => {
  try {
    const entry = joinRoomWaitlist({
      roomId: req.body.roomId || null,
      categoryId: req.body.categoryId || null,
      guestName: req.body.guestName,
      guestEmail: req.body.guestEmail,
      guestPhone: req.body.guestPhone || '',
      checkIn: req.body.checkIn,
      checkOut: req.body.checkOut,
      adults: req.body.adults || 2,
      children: req.body.children || 0,
      notes: req.body.notes || '',
      ipAddress: req.ip
    });
    res.status(201).json({ waitlistEntry: entry });
  } catch (err) {
    res.status(400).json({ error: err.code || 'WAITLIST_JOIN_FAILED', message: err.message });
  }
});

router.get('/admin/waitlist', requireRoles('receptionist', 'manager', 'admin'), (_req, res) => {
  const db = getDb();
  const entries = db.prepare(`
    SELECT w.*, r.room_number, r.name AS room_name, c.name AS category_name
    FROM waitlist_entries w
    LEFT JOIN rooms r ON r.id = w.room_id
    LEFT JOIN room_categories c ON c.id = w.category_id
    ORDER BY w.id DESC LIMIT 50
  `).all();
  res.json({ waitlist: entries });
});

// 2. PrintableTaxInvoiceAndFolioGeneratorModule Endpoint
router.get('/bookings/:bookingReference/invoice', (req, res) => {
  const invoice = generatePrintableTaxInvoice(req.params.bookingReference);
  if (!invoice) {
    return res.status(404).json({ error: 'RESERVATION_NOT_FOUND', message: 'Reservation not found.' });
  }
  if (req.query.format === 'html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(invoice.html);
  }
  res.json(invoice);
});

// 4. HousekeepingStaffAssignmentAndChecklistModule Endpoints
router.get('/admin/housekeeping', requireRoles('receptionist', 'manager', 'admin'), (_req, res) => {
  const db = getDb();
  const checklists = db.prepare('SELECT * FROM housekeeping_checklists ORDER BY id DESC LIMIT 40').all();
  res.json({ checklists });
});

router.post('/admin/rooms/:id/housekeeping-checklist', requireRoles('receptionist', 'manager', 'admin'), (req, res) => {
  try {
    const result = submitHousekeepingChecklist({
      roomId: Number(req.params.id),
      attendantName: req.body.attendantName,
      housekeepingStatus: req.body.housekeepingStatus || 'clean_inspected',
      linenChanged: req.body.linenChanged !== false,
      marbleSanitised: req.body.marbleSanitised !== false,
      minibarRestocked: req.body.minibarRestocked !== false,
      floralsRefreshed: req.body.floralsRefreshed !== false,
      supervisorVerified: req.body.supervisorVerified !== false,
      notes: req.body.notes || '',
      inspectedBy: `${req.user.first_name} ${req.user.last_name} (${req.user.role})`,
      actorId: req.user.id,
      actorRole: req.user.role,
      actorEmail: req.user.email,
      ipAddress: req.ip
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.code || 'HOUSEKEEPING_CHECKLIST_FAILED', message: err.message });
  }
});

// 5. RealTimeServerSentEventsPushModule (SSELiveFrontDeskFeed) Endpoints
router.get('/admin/events', (req, res) => {
  registerSseClient(res);
});

router.get('/admin/events/recent', requireRoles('receptionist', 'finance', 'manager', 'admin'), (_req, res) => {
  res.json({ events: getRecentFrontDeskEvents() });
});

// ---------------------------------------------------------------------------
// 6. Complete Two-Way Messaging Inbox System (Guest <-> Admin / Concierge)
// ---------------------------------------------------------------------------

// Guest: List all message threads for the signed-in user
router.get('/guest/messages', requireAuth, (req, res) => {
  const db = getDb();
  const threads = db.prepare(`
    SELECT
      t.*,
      (SELECT COUNT(*) FROM thread_messages tm WHERE tm.thread_id = t.id) AS messages_count,
      (SELECT body FROM thread_messages tm WHERE tm.thread_id = t.id ORDER BY tm.id DESC LIMIT 1) AS last_message_preview,
      (SELECT sender_name FROM thread_messages tm WHERE tm.thread_id = t.id ORDER BY tm.id DESC LIMIT 1) AS last_sender_name
    FROM message_threads t
    WHERE t.user_id = ? OR LOWER(t.guest_email) = LOWER(?)
    ORDER BY t.last_message_at DESC, t.id DESC
  `).all(req.user.id, req.user.email);

  const unreadCount = threads.reduce((sum, t) => sum + Number(t.unread_by_guest || 0), 0);
  res.json({ threads, unreadCount });
});

// Guest: Start a new message thread to Admin / Concierge
router.post('/guest/messages', requireAuth, (req, res) => {
  const {
    subject,
    message,
    department = 'Head Concierge & Admin',
    bookingReference = '',
    priority = 'normal'
  } = req.body;

  if (!subject || !message) {
    return res.status(400).json({
      error: 'MISSING_FIELDS',
      message: 'Subject and message body are required.'
    });
  }

  const db = getDb();
  const threadRef = `MSG-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const validPriority = priority === 'vip_urgent' ? 'vip_urgent' : 'normal';
  const guestName = `${req.user.first_name} ${req.user.last_name}`.trim();

  const tRes = db.prepare(`
    INSERT INTO message_threads (
      thread_reference, user_id, guest_name, guest_email, booking_reference,
      department, subject, status, priority, unread_by_admin, unread_by_guest,
      last_message_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_staff', ?, 1, 0, datetime('now'), datetime('now'))
  `).run(
    threadRef,
    req.user.id,
    guestName,
    req.user.email,
    String(bookingReference || '').trim(),
    String(department || 'Head Concierge & Admin').trim(),
    String(subject).trim(),
    validPriority
  );

  const threadId = Number(tRes.lastInsertRowid);
  db.prepare(`
    INSERT INTO thread_messages (
      thread_id, sender_user_id, sender_role, sender_name, sender_email, body, is_read
    ) VALUES (?, ?, 'guest', ?, ?, ?, 0)
  `).run(threadId, req.user.id, guestName, req.user.email, String(message).trim());

  const thread = db.prepare('SELECT * FROM message_threads WHERE id = ?').get(threadId);
  const messages = db.prepare('SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY id ASC').all(threadId);

  logAudit({
    eventType: 'GUEST_MESSAGE_THREAD_CREATED',
    entityType: 'message_thread',
    entityId: threadRef,
    actorId: req.user.id,
    actorRole: req.user.role,
    actorEmail: req.user.email,
    summary: `Guest ${guestName} (${req.user.email}) started message thread ${threadRef}: "${thread.subject}".`,
    ipAddress: req.ip
  });

  broadcastFrontDeskEvent({
    type: 'MESSAGE_RECEIVED_FROM_GUEST',
    title: `New Guest Message (${threadRef})`,
    message: `${guestName}: "${thread.subject}" (${thread.department})`
  });

  res.status(201).json({ thread: { ...thread, messages } });
});

// Guest: Get full conversation thread & messages (marks guest unread = 0)
router.get('/guest/messages/:threadId', requireAuth, (req, res) => {
  const db = getDb();
  const threadId = Number(req.params.threadId);
  const thread = db.prepare('SELECT * FROM message_threads WHERE id = ?').get(threadId);
  if (
    !thread ||
    (thread.user_id !== req.user.id && thread.guest_email.toLowerCase() !== req.user.email.toLowerCase())
  ) {
    return res.status(404).json({ error: 'THREAD_NOT_FOUND', message: 'Conversation thread not found.' });
  }

  db.prepare('UPDATE message_threads SET unread_by_guest = 0 WHERE id = ?').run(threadId);
  db.prepare("UPDATE thread_messages SET is_read = 1 WHERE thread_id = ? AND sender_role != 'guest'").run(threadId);

  const updatedThread = db.prepare('SELECT * FROM message_threads WHERE id = ?').get(threadId);
  const messages = db.prepare('SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY id ASC').all(threadId);

  res.json({ thread: { ...updatedThread, messages } });
});

// Guest: Reply in an existing message thread
router.post('/guest/messages/:threadId/reply', requireAuth, (req, res) => {
  const { body } = req.body;
  if (!body || !String(body).trim()) {
    return res.status(400).json({ error: 'EMPTY_MESSAGE', message: 'Reply message cannot be empty.' });
  }

  const db = getDb();
  const threadId = Number(req.params.threadId);
  const thread = db.prepare('SELECT * FROM message_threads WHERE id = ?').get(threadId);
  if (
    !thread ||
    (thread.user_id !== req.user.id && thread.guest_email.toLowerCase() !== req.user.email.toLowerCase())
  ) {
    return res.status(404).json({ error: 'THREAD_NOT_FOUND', message: 'Conversation thread not found.' });
  }

  const guestName = `${req.user.first_name} ${req.user.last_name}`.trim();
  db.prepare(`
    INSERT INTO thread_messages (
      thread_id, sender_user_id, sender_role, sender_name, sender_email, body, is_read
    ) VALUES (?, ?, 'guest', ?, ?, ?, 0)
  `).run(threadId, req.user.id, guestName, req.user.email, String(body).trim());

  db.prepare(`
    UPDATE message_threads
    SET status = 'awaiting_staff',
        unread_by_admin = unread_by_admin + 1,
        unread_by_guest = 0,
        last_message_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(threadId);

  const updatedThread = db.prepare('SELECT * FROM message_threads WHERE id = ?').get(threadId);
  const messages = db.prepare('SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY id ASC').all(threadId);

  broadcastFrontDeskEvent({
    type: 'MESSAGE_RECEIVED_FROM_GUEST',
    title: `Guest Reply in ${thread.thread_reference}`,
    message: `${guestName} replied in "${thread.subject}"`
  });

  res.status(201).json({ thread: { ...updatedThread, messages } });
});

// Admin / Staff: List all guest message threads with metrics
router.get('/admin/messages', requireRoles('receptionist', 'finance', 'manager', 'admin'), (req, res) => {
  const db = getDb();
  let sql = `
    SELECT
      t.*,
      (SELECT COUNT(*) FROM thread_messages tm WHERE tm.thread_id = t.id) AS messages_count,
      (SELECT body FROM thread_messages tm WHERE tm.thread_id = t.id ORDER BY tm.id DESC LIMIT 1) AS last_message_preview,
      (SELECT sender_name FROM thread_messages tm WHERE tm.thread_id = t.id ORDER BY tm.id DESC LIMIT 1) AS last_sender_name
    FROM message_threads t
    WHERE 1=1
  `;
  const params = [];
  if (req.query.status && req.query.status !== 'all') {
    sql += ' AND t.status = ?';
    params.push(req.query.status);
  }
  if (req.query.search) {
    const q = `%${req.query.search}%`;
    sql += ' AND (t.thread_reference LIKE ? OR t.guest_name LIKE ? OR t.guest_email LIKE ? OR t.subject LIKE ?)';
    params.push(q, q, q, q);
  }
  sql += ' ORDER BY t.unread_by_admin DESC, t.last_message_at DESC, t.id DESC';

  const threads = db.prepare(sql).all(...params);
  const allThreads = db.prepare('SELECT status, unread_by_admin FROM message_threads').all();

  const metrics = {
    totalThreads: allThreads.length,
    unreadThreadsCount: allThreads.filter((t) => Number(t.unread_by_admin || 0) > 0).length,
    awaitingStaffCount: allThreads.filter((t) => t.status === 'awaiting_staff' || t.status === 'open').length,
    resolvedCount: allThreads.filter((t) => t.status === 'resolved' || t.status === 'closed').length
  };

  res.json({ threads, metrics });
});

// Admin / Staff: Initiate a new direct message thread to a guest
router.post('/admin/messages', requireRoles('receptionist', 'finance', 'manager', 'admin'), (req, res) => {
  const {
    guestEmail,
    guestName = 'Valued Guest',
    subject,
    message,
    department = 'Head Concierge & Admin',
    bookingReference = '',
    priority = 'normal'
  } = req.body;

  if (!guestEmail || !subject || !message) {
    return res.status(400).json({
      error: 'MISSING_FIELDS',
      message: 'guestEmail, subject, and message are required.'
    });
  }

  const db = getDb();
  const cleanEmail = String(guestEmail).trim().toLowerCase();
  const matchedUser = db.prepare('SELECT id, first_name, last_name FROM users WHERE LOWER(email) = ?').get(cleanEmail);
  const resolvedGuestName = matchedUser ? `${matchedUser.first_name} ${matchedUser.last_name}` : String(guestName).trim();

  const threadRef = `MSG-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const tRes = db.prepare(`
    INSERT INTO message_threads (
      thread_reference, user_id, guest_name, guest_email, booking_reference,
      department, subject, status, priority, unread_by_admin, unread_by_guest,
      last_message_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_guest', ?, 0, 1, datetime('now'), datetime('now'))
  `).run(
    threadRef,
    matchedUser ? matchedUser.id : null,
    resolvedGuestName,
    cleanEmail,
    String(bookingReference || '').trim(),
    String(department).trim(),
    String(subject).trim(),
    priority === 'vip_urgent' ? 'vip_urgent' : 'normal'
  );

  const threadId = Number(tRes.lastInsertRowid);
  const staffDisplayName = `${req.user.first_name} ${req.user.last_name} (${req.user.role.toUpperCase()})`;
  db.prepare(`
    INSERT INTO thread_messages (
      thread_id, sender_user_id, sender_role, sender_name, sender_email, body, is_read
    ) VALUES (?, ?, ?, ?, ?, ?, 0)
  `).run(threadId, req.user.id, req.user.role, staffDisplayName, req.user.email, String(message).trim());

  const thread = db.prepare('SELECT * FROM message_threads WHERE id = ?').get(threadId);
  const messages = db.prepare('SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY id ASC').all(threadId);

  res.status(201).json({ thread: { ...thread, messages } });
});

// Admin / Staff: Inspect a specific thread & messages (marks admin unread = 0)
router.get('/admin/messages/:threadId', requireRoles('receptionist', 'finance', 'manager', 'admin'), (req, res) => {
  const db = getDb();
  const threadId = Number(req.params.threadId);
  const thread = db.prepare('SELECT * FROM message_threads WHERE id = ?').get(threadId);
  if (!thread) {
    return res.status(404).json({ error: 'THREAD_NOT_FOUND', message: 'Message thread not found.' });
  }

  db.prepare('UPDATE message_threads SET unread_by_admin = 0 WHERE id = ?').run(threadId);
  db.prepare("UPDATE thread_messages SET is_read = 1 WHERE thread_id = ? AND sender_role = 'guest'").run(threadId);

  const updatedThread = db.prepare('SELECT * FROM message_threads WHERE id = ?').get(threadId);
  const messages = db.prepare('SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY id ASC').all(threadId);

  res.json({ thread: { ...updatedThread, messages } });
});

// Admin / Staff: Reply to a user's message thread
router.post('/admin/messages/:threadId/reply', requireRoles('receptionist', 'finance', 'manager', 'admin'), (req, res) => {
  const { body, status = 'awaiting_guest' } = req.body;
  if (!body || !String(body).trim()) {
    return res.status(400).json({ error: 'EMPTY_MESSAGE', message: 'Admin reply cannot be empty.' });
  }

  const db = getDb();
  const threadId = Number(req.params.threadId);
  const thread = db.prepare('SELECT * FROM message_threads WHERE id = ?').get(threadId);
  if (!thread) {
    return res.status(404).json({ error: 'THREAD_NOT_FOUND', message: 'Message thread not found.' });
  }

  const staffDisplayName = `${req.user.first_name} ${req.user.last_name} (${req.user.role.toUpperCase()})`;
  const cleanBody = String(body).trim();

  db.prepare(`
    INSERT INTO thread_messages (
      thread_id, sender_user_id, sender_role, sender_name, sender_email, body, is_read
    ) VALUES (?, ?, ?, ?, ?, ?, 0)
  `).run(threadId, req.user.id, req.user.role, staffDisplayName, req.user.email, cleanBody);

  const validStatuses = ['open', 'awaiting_staff', 'awaiting_guest', 'resolved', 'closed'];
  const nextStatus = validStatuses.includes(status) ? status : 'awaiting_guest';

  db.prepare(`
    UPDATE message_threads
    SET status = ?,
        unread_by_admin = 0,
        unread_by_guest = unread_by_guest + 1,
        last_message_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(nextStatus, threadId);

  // Also record a notification in the user's notification log
  db.prepare(`
    INSERT INTO notifications (
      user_id, recipient_email, channel, template_code, subject, body, status
    ) VALUES (?, ?, 'email', 'DIRECT_MESSAGE_REPLY', ?, ?, 'sent')
  `).run(
    thread.user_id || null,
    thread.guest_email,
    `New Reply from ${staffDisplayName} — [${thread.thread_reference}] ${thread.subject}`,
    `Dear ${thread.guest_name},\n\n${staffDisplayName} has replied to your conversation "${thread.subject}" (${thread.thread_reference}):\n\n"${cleanBody}"`
  );

  logAudit({
    eventType: 'ADMIN_MESSAGE_REPLY_SENT',
    entityType: 'message_thread',
    entityId: thread.thread_reference,
    actorId: req.user.id,
    actorRole: req.user.role,
    actorEmail: req.user.email,
    summary: `Staff ${staffDisplayName} replied to ${thread.guest_email} in thread ${thread.thread_reference}.`,
    ipAddress: req.ip
  });

  broadcastFrontDeskEvent({
    type: 'ADMIN_REPLIED_TO_GUEST',
    title: `Admin Replied (${thread.thread_reference})`,
    message: `${staffDisplayName} replied to ${thread.guest_name}`
  });

  const updatedThread = db.prepare('SELECT * FROM message_threads WHERE id = ?').get(threadId);
  const messages = db.prepare('SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY id ASC').all(threadId);

  res.status(201).json({ thread: { ...updatedThread, messages } });
});

// Admin / Staff: Update thread status or priority
router.patch('/admin/messages/:threadId/status', requireRoles('receptionist', 'finance', 'manager', 'admin'), (req, res) => {
  const db = getDb();
  const threadId = Number(req.params.threadId);
  const thread = db.prepare('SELECT * FROM message_threads WHERE id = ?').get(threadId);
  if (!thread) {
    return res.status(404).json({ error: 'THREAD_NOT_FOUND', message: 'Message thread not found.' });
  }

  const validStatuses = ['open', 'awaiting_staff', 'awaiting_guest', 'resolved', 'closed'];
  const nextStatus = validStatuses.includes(req.body.status) ? req.body.status : thread.status;
  const nextPriority = req.body.priority === 'vip_urgent' ? 'vip_urgent' : req.body.priority === 'normal' ? 'normal' : thread.priority;

  db.prepare(`
    UPDATE message_threads
    SET status = ?, priority = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(nextStatus, nextPriority, threadId);

  const updatedThread = db.prepare('SELECT * FROM message_threads WHERE id = ?').get(threadId);
  const messages = db.prepare('SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY id ASC').all(threadId);

  res.json({ thread: { ...updatedThread, messages } });
});

// Guest: Mark all guest message threads as read
router.post('/guest/messages/mark-all-read', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare(`
    UPDATE message_threads
    SET unread_by_guest = 0
    WHERE user_id = ? OR LOWER(guest_email) = LOWER(?)
  `).run(req.user.id, req.user.email);
  res.json({ markedRead: true });
});

// Admin / Staff: Mark all admin message threads as read
router.post('/admin/messages/mark-all-read', requireRoles('receptionist', 'finance', 'manager', 'admin'), (_req, res) => {
  const db = getDb();
  db.prepare('UPDATE message_threads SET unread_by_admin = 0').run();
  db.prepare("UPDATE thread_messages SET is_read = 1 WHERE sender_role = 'guest'").run();
  res.json({ markedRead: true });
});

// Admin / Staff: Delete / archive a message thread
router.delete('/admin/messages/:threadId', requireRoles('manager', 'admin'), (req, res) => {
  const db = getDb();
  const threadId = Number(req.params.threadId);
  const existing = db.prepare('SELECT * FROM message_threads WHERE id = ?').get(threadId);
  if (!existing) {
    return res.status(404).json({ error: 'THREAD_NOT_FOUND', message: 'Message thread not found.' });
  }
  db.prepare('DELETE FROM message_threads WHERE id = ?').run(threadId);
  logAudit({
    eventType: 'ADMIN_MESSAGE_THREAD_DELETED',
    entityType: 'message_thread',
    entityId: existing.thread_reference,
    actorId: req.user.id,
    actorRole: req.user.role,
    actorEmail: req.user.email,
    summary: `Deleted message thread ${existing.thread_reference} (${existing.subject}).`,
    ipAddress: req.ip
  });
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// 7. Public Contact Page & Interactive Map Inquiry -> Admin Messaging Inbox
// ---------------------------------------------------------------------------

// Public / Guest: Submit a Contact Page message directly into the Admin Messaging Inbox
router.post('/contact/messages', (req, res) => {
  const {
    guestName,
    guestEmail,
    guestPhone = '',
    bookingReference = '',
    department = 'Head Concierge & Admin',
    priority = 'normal',
    subject,
    message,
    mapPoint = ''
  } = req.body;

  const resolvedEmail = String(guestEmail || (req.user && req.user.email) || '').trim().toLowerCase();
  const resolvedName = String(
    guestName || (req.user ? `${req.user.first_name} ${req.user.last_name}` : '')
  ).trim();

  if (!resolvedName || !resolvedEmail || !subject || !message) {
    return res.status(400).json({
      error: 'MISSING_CONTACT_FIELDS',
      message: 'Full Name, Email Address, Subject, and Message are required.'
    });
  }

  const db = getDb();
  const matchedUser = req.user
    ? { id: req.user.id, first_name: req.user.first_name, last_name: req.user.last_name }
    : db.prepare('SELECT id, first_name, last_name FROM users WHERE LOWER(email) = ?').get(resolvedEmail);

  const threadRef = `MSG-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const validPriority = priority === 'vip_urgent' ? 'vip_urgent' : 'normal';
  const cleanSubject = String(subject).trim();
  const cleanDepartment = String(department || 'Head Concierge & Admin').trim();
  const cleanBookingRef = String(bookingReference || '').trim();

  const metaLines = [];
  if (guestPhone && String(guestPhone).trim()) {
    metaLines.push(`Phone: ${String(guestPhone).trim()}`);
  }
  if (mapPoint && String(mapPoint).trim()) {
    metaLines.push(`Map Landmark / Arrival Point: ${String(mapPoint).trim()}`);
  }
  const formattedBody = metaLines.length > 0
    ? `[Contact Page Inquiry • ${metaLines.join(' | ')}]\n\n${String(message).trim()}`
    : String(message).trim();

  const tRes = db.prepare(`
    INSERT INTO message_threads (
      thread_reference, user_id, guest_name, guest_email, booking_reference,
      department, subject, status, priority, unread_by_admin, unread_by_guest,
      last_message_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_staff', ?, 1, 0, datetime('now'), datetime('now'))
  `).run(
    threadRef,
    matchedUser ? matchedUser.id : null,
    resolvedName,
    resolvedEmail,
    cleanBookingRef,
    cleanDepartment,
    cleanSubject,
    validPriority
  );

  const threadId = Number(tRes.lastInsertRowid);
  db.prepare(`
    INSERT INTO thread_messages (
      thread_id, sender_user_id, sender_role, sender_name, sender_email, body, is_read
    ) VALUES (?, ?, 'guest', ?, ?, ?, 0)
  `).run(
    threadId,
    matchedUser ? matchedUser.id : null,
    resolvedName,
    resolvedEmail,
    formattedBody
  );

  // Record confirmation notification
  db.prepare(`
    INSERT INTO notifications (
      user_id, recipient_email, channel, template_code, subject, body, status
    ) VALUES (?, ?, 'email', 'CONTACT_PAGE_INQUIRY', ?, ?, 'sent')
  `).run(
    matchedUser ? matchedUser.id : null,
    resolvedEmail,
    `We Have Received Your Inquiry [${threadRef}] — ${cleanSubject}`,
    `Dear ${resolvedName},\n\nThank you for contacting Maison Aurélia (${cleanDepartment}). Your message has been routed directly to our Admin & Concierge Inbox under reference ${threadRef}.`
  );

  logAudit({
    eventType: 'CONTACT_PAGE_MESSAGE_RECEIVED',
    entityType: 'message_thread',
    entityId: threadRef,
    actorId: matchedUser ? matchedUser.id : null,
    actorRole: req.user ? req.user.role : 'guest',
    actorEmail: resolvedEmail,
    summary: `Contact Page message ${threadRef} from ${resolvedName} (${resolvedEmail}) routed to Admin Inbox: "${cleanSubject}".`,
    ipAddress: req.ip
  });

  broadcastFrontDeskEvent({
    type: 'MESSAGE_RECEIVED_FROM_GUEST',
    title: `New Contact Page Message (${threadRef})`,
    message: `${resolvedName} (${cleanDepartment}): "${cleanSubject}"`
  });

  const thread = db.prepare('SELECT * FROM message_threads WHERE id = ?').get(threadId);
  const messages = db.prepare('SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY id ASC').all(threadId);

  res.status(201).json({ thread: { ...thread, messages } });
});

// Public / Guest: Lookup a Contact Page thread by threadReference + email
router.get('/contact/messages/lookup', (req, res) => {
  const threadReference = String(req.query.threadReference || '').trim().toUpperCase();
  const email = String(req.query.email || '').trim().toLowerCase();

  if (!threadReference || !email) {
    return res.status(400).json({
      error: 'MISSING_LOOKUP_PARAMS',
      message: 'Both threadReference (e.g. MSG-XXXXXX) and email are required.'
    });
  }

  const db = getDb();
  const thread = db.prepare(
    'SELECT * FROM message_threads WHERE UPPER(thread_reference) = ? AND LOWER(guest_email) = ?'
  ).get(threadReference, email);

  if (!thread) {
    return res.status(404).json({
      error: 'THREAD_NOT_FOUND',
      message: 'No message thread found matching that Reference and Email Address.'
    });
  }

  db.prepare('UPDATE message_threads SET unread_by_guest = 0 WHERE id = ?').run(thread.id);
  db.prepare("UPDATE thread_messages SET is_read = 1 WHERE thread_id = ? AND sender_role != 'guest'").run(thread.id);

  const updatedThread = db.prepare('SELECT * FROM message_threads WHERE id = ?').get(thread.id);
  const messages = db.prepare('SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY id ASC').all(thread.id);

  res.json({ thread: { ...updatedThread, messages } });
});

// Public / Guest: Reply to a thread from the Contact Page using threadReference + email
router.post('/contact/messages/:threadReference/reply', (req, res) => {
  const threadReference = String(req.params.threadReference || '').trim().toUpperCase();
  const email = String(req.body.email || (req.user && req.user.email) || '').trim().toLowerCase();
  const body = String(req.body.body || '').trim();

  if (!threadReference || !email || !body) {
    return res.status(400).json({
      error: 'MISSING_FIELDS',
      message: 'threadReference, email, and reply body are required.'
    });
  }

  const db = getDb();
  const thread = db.prepare(
    'SELECT * FROM message_threads WHERE UPPER(thread_reference) = ? AND LOWER(guest_email) = ?'
  ).get(threadReference, email);

  if (!thread) {
    return res.status(404).json({
      error: 'THREAD_NOT_FOUND',
      message: 'Conversation thread not found for that reference and email.'
    });
  }

  db.prepare(`
    INSERT INTO thread_messages (
      thread_id, sender_user_id, sender_role, sender_name, sender_email, body, is_read
    ) VALUES (?, ?, 'guest', ?, ?, ?, 0)
  `).run(thread.id, thread.user_id || null, thread.guest_name, thread.guest_email, body);

  db.prepare(`
    UPDATE message_threads
    SET status = 'awaiting_staff',
        unread_by_admin = unread_by_admin + 1,
        unread_by_guest = 0,
        last_message_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(thread.id);

  broadcastFrontDeskEvent({
    type: 'MESSAGE_RECEIVED_FROM_GUEST',
    title: `Contact Thread Reply (${thread.thread_reference})`,
    message: `${thread.guest_name} replied in "${thread.subject}"`
  });

  const updatedThread = db.prepare('SELECT * FROM message_threads WHERE id = ?').get(thread.id);
  const messages = db.prepare('SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY id ASC').all(thread.id);

  res.status(201).json({ thread: { ...updatedThread, messages } });
});

module.exports = router;
