const { getDb } = require('../db/database');
const { logAudit } = require('./auditService');

const CURRENCY_RATES = {
  USD: { code: 'USD', symbol: '$', rate: 1.0, name: 'US Dollar' },
  EUR: { code: 'EUR', symbol: '€', rate: 0.92, name: 'Euro' },
  GBP: { code: 'GBP', symbol: '£', rate: 0.79, name: 'British Pound' },
  CHF: { code: 'CHF', symbol: 'CHF ', rate: 0.88, name: 'Swiss Franc' },
  AED: { code: 'AED', symbol: 'AED ', rate: 3.67, name: 'UAE Dirham' },
  NGN: { code: 'NGN', symbol: '₦', rate: 1550.0, name: 'Nigerian Naira' }
};

function getCurrencyInfo(currencyCode = 'USD') {
  const code = String(currencyCode || 'USD').toUpperCase();
  return CURRENCY_RATES[code] || CURRENCY_RATES.USD;
}

function roundMoney(amount) {
  return Math.round((Number(amount) + Number.EPSILON) * 100) / 100;
}

function parseJsonSafe(str, fallback = []) {
  try {
    return JSON.parse(str);
  } catch (_) {
    return fallback;
  }
}

function isValidDateString(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return false;
  const d = new Date(`${dateStr}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === dateStr;
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function diffNights(checkIn, checkOut) {
  const d1 = new Date(`${checkIn}T00:00:00Z`);
  const d2 = new Date(`${checkOut}T00:00:00Z`);
  return Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
}

function validateStayDates(checkIn, checkOut) {
  if (!isValidDateString(checkIn) || !isValidDateString(checkOut)) {
    const err = new Error('Please provide valid check-in and check-out dates in YYYY-MM-DD format.');
    err.code = 'INVALID_DATES';
    throw err;
  }
  const nights = diffNights(checkIn, checkOut);
  if (nights < 1) {
    const err = new Error('Check-out date must be at least 1 night after check-in date.');
    err.code = 'INVALID_DATE_RANGE';
    throw err;
  }
  if (nights > 90) {
    const err = new Error('Online reservations are limited to 90 nights maximum. Please contact our Private Concierge for extended residencies.');
    err.code = 'MAX_STAY_EXCEEDED';
    throw err;
  }
  return { checkIn, checkOut, nights };
}

/**
 * Releases any expired room holds in the database and logs the expiration.
 */
function releaseExpiredHolds() {
  const db = getDb();
  const expired = db.prepare(`
    SELECT id, hold_token, room_id, check_in, check_out
    FROM room_holds
    WHERE status = 'ACTIVE' AND expires_at <= datetime('now')
  `).all();

  if (expired.length > 0) {
    const updateStmt = db.prepare(`
      UPDATE room_holds
      SET status = 'EXPIRED'
      WHERE id = ? AND status = 'ACTIVE'
    `);
    for (const h of expired) {
      updateStmt.run(h.id);
      logAudit({
        eventType: 'HOLD_EXPIRED',
        entityType: 'room_hold',
        entityId: h.hold_token,
        summary: `Temporary inventory hold ${h.hold_token} for room ID ${h.room_id} (${h.check_in} to ${h.check_out}) expired and released inventory.`,
        details: h
      });
    }
  }
  return expired.length;
}

function getHotelSettings() {
  const db = getDb();
  return db.prepare('SELECT * FROM hotel_settings WHERE id = 1').get();
}

/**
 * Checks whether a specific physical room is available for [checkIn, checkOut).
 * Accounts for hotel turnover policy (same_day_turnover = 1 allows arrival on another guest's departure day;
 * same_day_turnover = 0 enforces a 1-day buffer).
 */
function checkSingleRoomAvailability(roomId, checkIn, checkOut, excludeSessionId = null, excludeHoldToken = null) {
  releaseExpiredHolds();
  const db = getDb();
  const settings = getHotelSettings();
  const room = db.prepare(`
    SELECT r.*, c.name AS category_name, c.slug AS category_slug
    FROM rooms r
    JOIN room_categories c ON c.id = r.category_id
    WHERE r.id = ?
  `).get(roomId);

  if (!room) {
    return { available: false, reason: 'ROOM_NOT_FOUND' };
  }

  if (room.status !== 'available') {
    return {
      available: false,
      reason: 'ROOM_OUT_OF_SERVICE',
      conflictDetails: `Room #${room.room_number} is currently marked as ${room.status}.`
    };
  }

  // If hotel turnover policy disallows same-day turnover, expand effective check window by 1 day on each side
  const effectiveCheckIn = settings && settings.same_day_turnover === 0 ? addDays(checkIn, -1) : checkIn;
  const effectiveCheckOut = settings && settings.same_day_turnover === 0 ? addDays(checkOut, 1) : checkOut;

  // 1. Check active confirmed/checked-in reservations
  const conflictingReservation = db.prepare(`
    SELECT rr.id, rr.check_in, rr.check_out, res.booking_reference, res.status
    FROM reservation_rooms rr
    JOIN reservations res ON res.id = rr.reservation_id
    WHERE rr.room_id = ?
      AND rr.status = 'active'
      AND res.status IN ('confirmed', 'checked_in', 'pending_payment')
      AND rr.check_in < ?
      AND rr.check_out > ?
    LIMIT 1
  `).get(roomId, effectiveCheckOut, effectiveCheckIn);

  if (conflictingReservation) {
    return {
      available: false,
      reason: 'ALREADY_BOOKED',
      conflictDetails: `Booked from ${conflictingReservation.check_in} to ${conflictingReservation.check_out}`
    };
  }

  // 2. Check active maintenance blocks
  const conflictingMaintenance = db.prepare(`
    SELECT id, start_date, end_date, reason
    FROM maintenance_blocks
    WHERE room_id = ?
      AND status = 'active'
      AND start_date < ?
      AND end_date > ?
    LIMIT 1
  `).get(roomId, checkOut, checkIn);

  if (conflictingMaintenance) {
    return {
      available: false,
      reason: 'MAINTENANCE_BLOCK',
      conflictDetails: `Scheduled maintenance (${conflictingMaintenance.reason}) from ${conflictingMaintenance.start_date} to ${conflictingMaintenance.end_date}`
    };
  }

  // 3. Check active non-expired checkout holds from other guests/sessions
  let holdSql = `
    SELECT id, hold_token, check_in, check_out, expires_at, session_id
    FROM room_holds
    WHERE room_id = ?
      AND status = 'ACTIVE'
      AND expires_at > datetime('now')
      AND check_in < ?
      AND check_out > ?
  `;
  const holdParams = [roomId, effectiveCheckOut, effectiveCheckIn];
  if (excludeSessionId) {
    holdSql += ' AND session_id != ?';
    holdParams.push(excludeSessionId);
  }
  if (excludeHoldToken) {
    holdSql += ' AND hold_token != ?';
    holdParams.push(excludeHoldToken);
  }
  holdSql += ' LIMIT 1';

  const conflictingHold = db.prepare(holdSql).get(...holdParams);
  if (conflictingHold) {
    return {
      available: false,
      reason: 'HELD_IN_CHECKOUT',
      conflictDetails: `Temporarily held in checkout until ${conflictingHold.expires_at} UTC`
    };
  }

  return {
    available: true,
    reason: 'AVAILABLE',
    conflictDetails: null
  };
}

/**
 * Calculates full stay pricing for one or more rooms, including seasonal adjustments,
 * optional extras, promotional code discounts, taxes, fees, deposit options, and currency conversion.
 */
function calculateStayPricing({
  roomIds = [],
  checkIn,
  checkOut,
  adults = 2,
  children = 0,
  selectedAddons = [],
  promoCode = '',
  paymentPlan = 'full',
  currency = 'USD'
}) {
  const { nights } = validateStayDates(checkIn, checkOut);
  const db = getDb();
  const settings = getHotelSettings();
  const seasonalRates = db.prepare('SELECT * FROM seasonal_rates WHERE is_active = 1').all();
  const curInfo = getCurrencyInfo(currency);

  let baseRoomSubtotal = 0;
  let seasonalAdjustmentTotal = 0;
  const roomBreakdowns = [];

  for (const roomId of roomIds) {
    const room = db.prepare(`
      SELECT r.*, c.name AS category_name
      FROM rooms r
      JOIN room_categories c ON c.id = r.category_id
      WHERE r.id = ?
    `).get(roomId);
    if (!room) continue;

    let roomBaseSum = 0;
    let roomSeasonalDiff = 0;
    const appliedSeasonBadges = new Set();

    for (let i = 0; i < nights; i++) {
      const nightDate = addDays(checkIn, i);
      roomBaseSum += room.price_per_night;

      // Check if any seasonal rate applies to this date & category
      const matchingSeason = seasonalRates.find((sr) => {
        const catMatch = !sr.category_id || sr.category_id === room.category_id;
        return catMatch && nightDate >= sr.start_date && nightDate < sr.end_date;
      });

      if (matchingSeason && matchingSeason.multiplier !== 1.0) {
        const diff = room.price_per_night * (matchingSeason.multiplier - 1.0);
        roomSeasonalDiff += diff;
        if (matchingSeason.badge_text) appliedSeasonBadges.add(matchingSeason.badge_text);
      }

      // Dynamic Yield / Scarcity Pricing Engine
      if (settings && settings.dynamic_yield_enabled && Number(settings.high_demand_multiplier) > 1.0) {
        const nextDay = addDays(nightDate, 1);
        const totalInCat = db.prepare("SELECT COUNT(*) AS cnt FROM rooms WHERE category_id = ? AND status = 'available'").get(room.category_id).cnt;
        if (totalInCat > 1) {
          const occupiedInCat = db.prepare(`
            SELECT COUNT(DISTINCT r.id) AS cnt
            FROM rooms r
            WHERE r.category_id = ?
              AND r.id != ?
              AND (
                EXISTS (
                  SELECT 1 FROM reservation_rooms rr
                  JOIN reservations res ON res.id = rr.reservation_id
                  WHERE rr.room_id = r.id AND rr.status = 'active'
                    AND res.status IN ('confirmed', 'checked_in')
                    AND rr.check_in < ? AND rr.check_out > ?
                )
                OR EXISTS (
                  SELECT 1 FROM maintenance_blocks mb
                  WHERE mb.room_id = r.id AND mb.status = 'active'
                    AND mb.start_date < ? AND mb.end_date > ?
                )
              )
          `).get(room.category_id, room.id, nextDay, nightDate, nextDay, nightDate).cnt;

          const catOccupancyPct = (occupiedInCat / totalInCat) * 100;
          const threshold = Number(settings.high_demand_occupancy_threshold || 50);
          if (catOccupancyPct >= threshold) {
            const yieldDiff = room.price_per_night * (Number(settings.high_demand_multiplier) - 1.0);
            roomSeasonalDiff += yieldDiff;
            appliedSeasonBadges.add(`High-Demand Yield (+${Math.round((Number(settings.high_demand_multiplier) - 1) * 100)}%)`);
          }
        }
      }
    }

    roomBaseSum = roundMoney(roomBaseSum);
    roomSeasonalDiff = roundMoney(roomSeasonalDiff);
    const effectiveRoomTotal = roundMoney(roomBaseSum + roomSeasonalDiff);

    baseRoomSubtotal = roundMoney(baseRoomSubtotal + roomBaseSum);
    seasonalAdjustmentTotal = roundMoney(seasonalAdjustmentTotal + roomSeasonalDiff);

    roomBreakdowns.push({
      roomId: room.id,
      roomNumber: room.room_number,
      uniqueCode: room.unique_code,
      roomName: room.name,
      categoryName: room.category_name,
      baseNightlyRate: room.price_per_night,
      effectiveNightlyRate: roundMoney(effectiveRoomTotal / nights),
      nights,
      baseSubtotal: roomBaseSum,
      seasonalAdjustment: roomSeasonalDiff,
      roomTotal: effectiveRoomTotal,
      seasonBadges: Array.from(appliedSeasonBadges)
    });
  }

  const combinedRoomRate = roundMoney(baseRoomSubtotal + seasonalAdjustmentTotal);

  // Calculate optional extras (addons)
  const totalGuests = Math.max(1, Number(adults || 1) + Number(children || 0));
  let extrasSubtotal = 0;
  const addonBreakdowns = [];

  if (Array.isArray(selectedAddons) && selectedAddons.length > 0) {
    for (const item of selectedAddons) {
      const codeOrId = typeof item === 'object' ? (item.code || item.id) : item;
      const requestedQty = typeof item === 'object' && item.quantity ? Math.max(1, Number(item.quantity)) : 1;

      const addon = db.prepare(
        'SELECT * FROM addons WHERE (code = ? OR id = ?) AND is_active = 1'
      ).get(String(codeOrId), Number(codeOrId) || -1);

      if (!addon) continue;

      let lineTotal = 0;
      let multiplierDesc = '';
      if (addon.pricing_type === 'per_stay') {
        lineTotal = addon.price * requestedQty;
        multiplierDesc = `${requestedQty} × per stay`;
      } else if (addon.pricing_type === 'per_night') {
        lineTotal = addon.price * nights * requestedQty;
        multiplierDesc = `${nights} night(s) × ${requestedQty}`;
      } else if (addon.pricing_type === 'per_guest') {
        lineTotal = addon.price * totalGuests;
        multiplierDesc = `${totalGuests} guest(s)`;
      } else if (addon.pricing_type === 'per_guest_per_night') {
        lineTotal = addon.price * totalGuests * nights;
        multiplierDesc = `${totalGuests} guest(s) × ${nights} night(s)`;
      }

      lineTotal = roundMoney(lineTotal);
      extrasSubtotal = roundMoney(extrasSubtotal + lineTotal);
      addonBreakdowns.push({
        addonId: addon.id,
        code: addon.code,
        name: addon.name,
        category: addon.category,
        unitPrice: addon.price,
        pricingType: addon.pricing_type,
        quantity: requestedQty,
        multiplierDesc,
        totalPrice: lineTotal
      });
    }
  }

  // Promo code calculation
  let discountAmount = 0;
  let appliedPromo = null;
  if (promoCode && String(promoCode).trim()) {
    const cleanCode = String(promoCode).trim().toUpperCase();
    const promo = db.prepare(`
      SELECT * FROM promo_codes
      WHERE UPPER(code) = ? AND is_active = 1
    `).get(cleanCode);

    if (promo) {
      const preTaxSubtotal = combinedRoomRate + extrasSubtotal;
      if (
        nights >= promo.min_nights &&
        preTaxSubtotal >= promo.min_amount &&
        promo.current_uses < promo.max_uses
      ) {
        if (promo.discount_type === 'percent') {
          discountAmount = roundMoney(combinedRoomRate * (promo.discount_value / 100));
        } else {
          discountAmount = roundMoney(Math.min(combinedRoomRate, promo.discount_value));
        }
        appliedPromo = {
          code: promo.code,
          description: promo.description,
          discountType: promo.discount_type,
          discountValue: promo.discount_value,
          discountAmount
        };
      }
    }
  }

  const netTaxableAmount = Math.max(0, roundMoney(combinedRoomRate + extrasSubtotal - discountAmount));
  const taxAmount = roundMoney(netTaxableAmount * (settings.tax_rate_percent / 100));
  const serviceFeeAmount = roundMoney(netTaxableAmount * (settings.service_fee_percent / 100));
  const cityLevyAmount = roundMoney(settings.city_levy_per_night * nights * Math.max(1, roomIds.length));

  const totalAmount = roundMoney(netTaxableAmount + taxAmount + serviceFeeAmount + cityLevyAmount);
  const depositPercent = settings.deposit_percent || 30;
  const depositAmount = roundMoney(totalAmount * (depositPercent / 100));
  const amountDueNow = paymentPlan === 'deposit' ? depositAmount : totalAmount;
  const balanceAtHotel = roundMoney(totalAmount - amountDueNow);

  return {
    checkIn,
    checkOut,
    nights,
    adults: Number(adults),
    children: Number(children),
    roomsCount: roomIds.length,
    baseCurrency: 'USD',
    displayCurrency: curInfo.code,
    currencySymbol: curInfo.symbol,
    exchangeRate: curInfo.rate,
    roomSubtotal: baseRoomSubtotal,
    seasonalAdjustment: seasonalAdjustmentTotal,
    combinedRoomRate,
    extrasSubtotal,
    discountAmount,
    appliedPromo,
    taxRatePercent: settings.tax_rate_percent,
    taxAmount,
    serviceFeePercent: settings.service_fee_percent,
    serviceFeeAmount,
    cityLevyPerNight: settings.city_levy_per_night,
    cityLevyAmount,
    totalAmount,
    depositPercent,
    depositAmount,
    paymentPlan,
    amountDueNow,
    balanceAtHotel,
    convertedTotalAmount: roundMoney(totalAmount * curInfo.rate),
    convertedAmountDueNow: roundMoney(amountDueNow * curInfo.rate),
    roomBreakdowns,
    addonBreakdowns
  };
}

/**
 * Finds nearby available date windows of the same length for a specific room
 * when the requested dates are unavailable.
 */
function findNearbyAvailableDatesForRoom(roomId, requestedCheckIn, nights, maxSuggestions = 3) {
  const suggestions = [];
  for (let offset = 1; offset <= 21 && suggestions.length < maxSuggestions; offset++) {
    const candidateStart = addDays(requestedCheckIn, offset);
    const candidateEnd = addDays(candidateStart, nights);
    const check = checkSingleRoomAvailability(roomId, candidateStart, candidateEnd);
    if (check.available) {
      suggestions.push({
        checkIn: candidateStart,
        checkOut: candidateEnd,
        nights
      });
      // Advance offset so suggestions are distinct windows
      offset += Math.max(1, Math.min(3, nights - 1));
    }
  }
  return suggestions;
}

function formatRoomRecord(room, category) {
  return {
    id: room.id,
    roomNumber: room.room_number,
    uniqueCode: room.unique_code,
    name: room.name,
    categoryId: room.category_id,
    categoryName: category ? category.name : room.category_name,
    categorySlug: category ? category.slug : room.category_slug,
    floor: room.floor,
    wing: room.wing,
    viewType: room.view_type,
    pricePerNight: room.price_per_night,
    maxAdults: room.max_adults,
    maxChildren: room.max_children,
    maxOccupancy: room.max_occupancy,
    bedType: room.bed_type,
    sizeSqm: room.size_sqm,
    sizeSqft: room.size_sqft,
    heroImage: room.hero_image,
    gallery: parseJsonSafe(room.gallery_json, [room.hero_image]),
    amenities: parseJsonSafe(room.amenities_json, []),
    facilities: parseJsonSafe(room.facilities_json, []),
    includedServices: parseJsonSafe(room.included_services_json, []),
    checkInPolicy: room.check_in_policy,
    checkOutPolicy: room.check_out_policy,
    cancellationPolicy: room.cancellation_policy,
    refundPolicy: room.refund_policy,
    isAccessible: Boolean(room.is_accessible),
    isSampleInventory: Boolean(room.is_sample_inventory),
    status: room.status,
    housekeepingStatus: room.housekeeping_status || 'clean_inspected',
    housekeepingUpdatedAt: room.housekeeping_updated_at || null,
    notes: room.notes || ''
  };
}

/**
 * Full availability search across all rooms and categories for given dates & guest requirements.
 */
function searchAvailability({
  checkIn,
  checkOut,
  adults = 2,
  children = 0,
  roomsRequired = 1,
  categorySlug = null,
  currency = 'USD',
  sessionId = null
}) {
  releaseExpiredHolds();
  const { nights } = validateStayDates(checkIn, checkOut);
  const reqAdults = Math.max(1, Number(adults) || 1);
  const reqChildren = Math.max(0, Number(children) || 0);
  const reqRooms = Math.max(1, Number(roomsRequired) || 1);
  const totalGuests = reqAdults + reqChildren;

  // Per-room minimum occupancy needed when booking multiple rooms
  const minAdultsPerRoom = Math.ceil(reqAdults / reqRooms);
  const minTotalPerRoom = Math.ceil(totalGuests / reqRooms);

  const db = getDb();
  const categories = db.prepare('SELECT * FROM room_categories ORDER BY sort_order ASC, id ASC').all();
  const allRooms = db.prepare(`
    SELECT r.*, c.name AS category_name, c.slug AS category_slug
    FROM rooms r
    JOIN room_categories c ON c.id = r.category_id
    ORDER BY c.sort_order ASC, r.room_number ASC
  `).all();

  const evaluatedRooms = allRooms
    .filter((r) => !categorySlug || categorySlug === 'all' || r.category_slug === categorySlug)
    .map((r) => {
      const formatted = formatRoomRecord(r);
      const availCheck = checkSingleRoomAvailability(r.id, checkIn, checkOut, sessionId);
      const fitsOccupancy =
        r.max_adults >= minAdultsPerRoom &&
        r.max_occupancy >= minTotalPerRoom;

      const isAvailableForSearch = availCheck.available && fitsOccupancy;
      const pricing = calculateStayPricing({
        roomIds: [r.id],
        checkIn,
        checkOut,
        adults: Math.min(reqAdults, r.max_adults),
        children: Math.min(reqChildren, r.max_children),
        currency
      });

      let availabilityHeading = 'Room Available';
      let availabilityMessage = 'This room is available for your selected dates. You can proceed with your reservation.';
      let nearbyDates = [];

      if (!availCheck.available) {
        availabilityHeading = 'Room Unavailable for Selected Dates';
        availabilityMessage = 'Sorry, this room has already been booked or is unavailable for part or all of your selected stay. Please choose different dates or explore other available rooms.';
        nearbyDates = findNearbyAvailableDatesForRoom(r.id, checkIn, nights, 3);
      } else if (!fitsOccupancy) {
        availabilityHeading = 'Capacity Exceeded for Single Room';
        availabilityMessage = `This room accommodates up to ${r.max_occupancy} guests (${r.max_adults} adults). Please increase the number of rooms or select a larger suite/family residence.`;
      }

      return {
        ...formatted,
        isAvailable: isAvailableForSearch,
        rawDateAvailable: availCheck.available,
        fitsOccupancy,
        unavailabilityReason: !availCheck.available
          ? availCheck.reason
          : !fitsOccupancy
          ? 'CAPACITY_EXCEEDED'
          : null,
        conflictDetails: availCheck.conflictDetails,
        availabilityHeading,
        availabilityMessage,
        pricing,
        nearbyAvailableDates: nearbyDates
      };
    });

  const availableRooms = evaluatedRooms.filter((r) => r.isAvailable);
  const unavailableRooms = evaluatedRooms.filter((r) => !r.isAvailable);

  // Attach alternative room recommendations to unavailable rooms
  for (const ur of unavailableRooms) {
    ur.alternativeRooms = availableRooms.slice(0, 3).map((ar) => ({
      id: ar.id,
      roomNumber: ar.roomNumber,
      name: ar.name,
      categoryName: ar.categoryName,
      pricePerNight: ar.pricePerNight,
      totalStayPrice: ar.pricing.totalAmount,
      heroImage: ar.heroImage
    }));
  }

  // Category-level inventory summary
  const categorySummaries = categories.map((cat) => {
    const roomsInCat = evaluatedRooms.filter((r) => r.categoryId === cat.id);
    const availableInCat = roomsInCat.filter((r) => r.isAvailable);
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
      isFeatured: Boolean(cat.is_featured),
      totalPhysicalRooms: roomsInCat.length,
      availablePhysicalRoomsCount: availableInCat.length,
      canFulfillRequestedRooms: availableInCat.length >= reqRooms
    };
  });

  return {
    searchParams: {
      checkIn,
      checkOut,
      nights,
      adults: reqAdults,
      children: reqChildren,
      roomsRequired: reqRooms,
      categorySlug: categorySlug || 'all',
      currency
    },
    canFulfillMultiRoomRequest: availableRooms.length >= reqRooms,
    totalAvailableRoomsCount: availableRooms.length,
    rooms: evaluatedRooms,
    availableRooms,
    unavailableRooms,
    categories: categorySummaries
  };
}

/**
 * Generates a 14-day daily availability & dynamic rate strip for a specific physical room.
 */
function getRoomAvailabilityStrip({ roomId, startDate = null, days = 14, currency = 'USD' }) {
  releaseExpiredHolds();
  const db = getDb();
  const room = db.prepare(`
    SELECT r.*, c.name AS category_name
    FROM rooms r JOIN room_categories c ON c.id = r.category_id
    WHERE r.id = ?
  `).get(Number(roomId));
  if (!room) return null;

  const baseStart = isValidDateString(startDate) ? startDate : new Date().toISOString().slice(0, 10);
  const numDays = Math.min(31, Math.max(7, Number(days) || 14));
  const curInfo = getCurrencyInfo(currency);
  const seasonalRates = db.prepare('SELECT * FROM seasonal_rates WHERE is_active = 1').all();

  const strip = [];
  for (let i = 0; i < numDays; i++) {
    const dayStart = addDays(baseStart, i);
    const dayEnd = addDays(baseStart, i + 1);
    const avail = checkSingleRoomAvailability(room.id, dayStart, dayEnd);

    const matchingSeason = seasonalRates.find((sr) => {
      const catMatch = !sr.category_id || sr.category_id === room.category_id;
      return catMatch && dayStart >= sr.start_date && dayStart < sr.end_date;
    });
    const multiplier = matchingSeason ? matchingSeason.multiplier : 1.0;
    const rateUsd = roundMoney(room.price_per_night * multiplier);

    strip.push({
      date: dayStart,
      nextDate: dayEnd,
      available: avail.available,
      statusReason: avail.reason,
      rateUsd,
      displayRate: roundMoney(rateUsd * curInfo.rate),
      currencySymbol: curInfo.symbol,
      seasonBadge: matchingSeason ? matchingSeason.badge_text : null
    });
  }

  return {
    roomId: room.id,
    roomNumber: room.room_number,
    roomName: room.name,
    housekeepingStatus: room.housekeeping_status || 'clean_inspected',
    startDate: baseStart,
    days: numDays,
    strip
  };
}

/**
 * Builds the 14-Day Front-Desk Tape Chart (Gantt Availability Grid) across all physical rooms.
 */
function getFrontDeskTapeChart({ startDate = null, days = 14 } = {}) {
  releaseExpiredHolds();
  const db = getDb();
  const baseStart = isValidDateString(startDate) ? startDate : new Date().toISOString().slice(0, 10);
  const numDays = Math.min(30, Math.max(7, Number(days) || 14));
  const endWindow = addDays(baseStart, numDays);

  const dateHeaders = [];
  for (let i = 0; i < numDays; i++) {
    dateHeaders.push(addDays(baseStart, i));
  }

  const rooms = db.prepare(`
    SELECT r.*, c.name AS category_name
    FROM rooms r
    JOIN room_categories c ON c.id = r.category_id
    ORDER BY c.sort_order ASC, r.room_number ASC
  `).all();

  const reservations = db.prepare(`
    SELECT rr.*, res.booking_reference, res.guest_first_name, res.guest_last_name, res.status AS res_status, res.payment_status
    FROM reservation_rooms rr
    JOIN reservations res ON res.id = rr.reservation_id
    WHERE rr.status = 'active'
      AND res.status IN ('confirmed', 'checked_in', 'pending_payment')
      AND rr.check_in < ? AND rr.check_out > ?
  `).all(endWindow, baseStart);

  const maintenanceBlocks = db.prepare(`
    SELECT * FROM maintenance_blocks
    WHERE status = 'active' AND start_date < ? AND end_date > ?
  `).all(endWindow, baseStart);

  const activeHolds = db.prepare(`
    SELECT * FROM room_holds
    WHERE status = 'ACTIVE' AND expires_at > datetime('now') AND check_in < ? AND check_out > ?
  `).all(endWindow, baseStart);

  const rows = rooms.map((room) => {
    const cells = dateHeaders.map((d) => {
      const resMatch = reservations.find(
        (r) => r.room_id === room.id && r.check_in <= d && r.check_out > d
      );
      if (resMatch) {
        return {
          date: d,
          state: resMatch.res_status === 'checked_in' ? 'checked_in' : 'booked',
          label: `${resMatch.guest_last_name} (${resMatch.booking_reference})`,
          bookingReference: resMatch.booking_reference,
          guestName: `${resMatch.guest_first_name} ${resMatch.guest_last_name}`
        };
      }

      const maintMatch = maintenanceBlocks.find(
        (m) => m.room_id === room.id && m.start_date <= d && m.end_date > d
      );
      if (maintMatch) {
        return {
          date: d,
          state: 'maintenance',
          label: maintMatch.reason,
          maintenanceId: maintMatch.id
        };
      }

      const holdMatch = activeHolds.find(
        (h) => h.room_id === room.id && h.check_in <= d && h.check_out > d
      );
      if (holdMatch) {
        return {
          date: d,
          state: 'held',
          label: `Hold ${holdMatch.hold_token}`,
          holdToken: holdMatch.hold_token
        };
      }

      if (room.status !== 'available') {
        return {
          date: d,
          state: 'out_of_service',
          label: room.status
        };
      }

      return {
        date: d,
        state: 'available',
        label: `$${room.price_per_night}`
      };
    });

    return {
      roomId: room.id,
      roomNumber: room.room_number,
      uniqueCode: room.unique_code,
      roomName: room.name,
      categoryName: room.category_name,
      status: room.status,
      housekeepingStatus: room.housekeeping_status || 'clean_inspected',
      pricePerNight: room.price_per_night,
      cells
    };
  });

  return {
    startDate: baseStart,
    endDate: endWindow,
    days: numDays,
    dateHeaders,
    rows
  };
}

/**
 * Generates an RFC 5545 iCal (.ics) feed for a physical room's reservations and maintenance closures.
 */
function generateRoomIcalFeed(roomId) {
  const db = getDb();
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(Number(roomId));
  if (!room) return null;

  const reservations = db.prepare(`
    SELECT rr.check_in, rr.check_out, res.booking_reference, res.created_at
    FROM reservation_rooms rr
    JOIN reservations res ON res.id = rr.reservation_id
    WHERE rr.room_id = ? AND rr.status = 'active' AND res.status IN ('confirmed', 'checked_in')
    ORDER BY rr.check_in ASC
  `).all(room.id);

  const maintenance = db.prepare(`
    SELECT id, start_date, end_date, reason, created_at
    FROM maintenance_blocks
    WHERE room_id = ? AND status = 'active'
    ORDER BY start_date ASC
  `).all(room.id);

  const dtStamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Maison Aurelia Grand Palace//NONSGML Reservation Engine//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:Maison Aurelia - Room #${room.room_number} (${room.unique_code})`
  ];

  for (const r of reservations) {
    const dtStart = r.check_in.replace(/-/g, '');
    const dtEnd = r.check_out.replace(/-/g, '');
    lines.push(
      'BEGIN:VEVENT',
      `UID:res-${r.booking_reference}-rm-${room.room_number}@maisonaurelia.luxury`,
      `DTSTAMP:${dtStamp}`,
      `DTSTART;VALUE=DATE:${dtStart}`,
      `DTEND;VALUE=DATE:${dtEnd}`,
      `SUMMARY:RESERVED - Room #${room.room_number} (${r.booking_reference})`,
      'STATUS:CONFIRMED',
      'TRANSP:OPAQUE',
      'END:VEVENT'
    );
  }

  for (const m of maintenance) {
    const dtStart = m.start_date.replace(/-/g, '');
    const dtEnd = m.end_date.replace(/-/g, '');
    lines.push(
      'BEGIN:VEVENT',
      `UID:maint-${m.id}-rm-${room.room_number}@maisonaurelia.luxury`,
      `DTSTAMP:${dtStamp}`,
      `DTSTART;VALUE=DATE:${dtStart}`,
      `DTEND;VALUE=DATE:${dtEnd}`,
      `SUMMARY:MAINTENANCE BLOCK - Room #${room.room_number}: ${m.reason}`,
      'STATUS:CONFIRMED',
      'TRANSP:OPAQUE',
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

function parseIcalDate(rawVal = '') {
  const clean = String(rawVal).trim().replace(/^.*:/, '');
  const m = clean.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const formatted = `${m[1]}-${m[2]}-${m[3]}`;
  return isValidDateString(formatted) ? formatted : null;
}

/**
 * InboundIcalChannelSyncModule:
 * Parses an RFC 5545 iCal (.ics) payload and imports external OTA / Channel Manager blocks
 * into maintenance_blocks for a physical room, skipping any conflicting blocks safely.
 */
function importRoomIcalFeed({
  roomId,
  icsContent,
  channelName = 'External Luxury Desk / OTA',
  createdBy = 'Channel Manager Sync',
  ipAddress = ''
}) {
  const db = getDb();
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(Number(roomId));
  if (!room) {
    const err = new Error('Physical room not found.');
    err.code = 'ROOM_NOT_FOUND';
    throw err;
  }

  if (!icsContent || !String(icsContent).includes('BEGIN:VCALENDAR')) {
    const err = new Error('Invalid iCal (.ics) payload: missing BEGIN:VCALENDAR header.');
    err.code = 'INVALID_ICAL_PAYLOAD';
    throw err;
  }

  const eventBlocks = String(icsContent).split('BEGIN:VEVENT').slice(1);
  const importedBlocks = [];
  const skippedBlocks = [];

  const insertBlock = db.prepare(`
    INSERT INTO maintenance_blocks (room_id, start_date, end_date, reason, created_by, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `);

  for (const rawBlock of eventBlocks) {
    const body = rawBlock.split('END:VEVENT')[0] || '';
    const lines = body.split(/\r?\n/);
    let startDate = null;
    let endDate = null;
    let summary = 'External Channel Reservation Block';

    for (const line of lines) {
      if (line.startsWith('DTSTART')) {
        startDate = parseIcalDate(line);
      } else if (line.startsWith('DTEND')) {
        endDate = parseIcalDate(line);
      } else if (line.startsWith('SUMMARY:')) {
        summary = line.slice('SUMMARY:'.length).trim() || summary;
      }
    }

    if (!startDate || !endDate || startDate >= endDate) {
      skippedBlocks.push({ startDate, endDate, summary, reason: 'INVALID_DATES' });
      continue;
    }

    // Check if an identical maintenance block already exists
    const duplicate = db.prepare(`
      SELECT id FROM maintenance_blocks
      WHERE room_id = ? AND status = 'active' AND start_date = ? AND end_date = ?
    `).get(room.id, startDate, endDate);

    if (duplicate) {
      skippedBlocks.push({ startDate, endDate, summary, reason: 'ALREADY_IMPORTED' });
      continue;
    }

    try {
      const reasonText = `[${channelName}] ${summary}`;
      const res = insertBlock.run(room.id, startDate, endDate, reasonText, createdBy);
      importedBlocks.push({
        id: Number(res.lastInsertRowid),
        roomId: room.id,
        roomNumber: room.room_number,
        startDate,
        endDate,
        reason: reasonText
      });
    } catch (err) {
      skippedBlocks.push({
        startDate,
        endDate,
        summary,
        reason: err.message
      });
    }
  }

  logAudit({
    eventType: 'ICAL_CHANNEL_IMPORT',
    entityType: 'room',
    entityId: room.room_number,
    actorRole: 'staff',
    summary: `Imported ${importedBlocks.length} iCal event block(s) for Room #${room.room_number} from ${channelName} (${skippedBlocks.length} skipped).`,
    details: { channelName, importedCount: importedBlocks.length, skippedCount: skippedBlocks.length },
    ipAddress
  });

  return {
    roomId: room.id,
    roomNumber: room.room_number,
    channelName,
    importedCount: importedBlocks.length,
    skippedCount: skippedBlocks.length,
    importedBlocks,
    skippedBlocks
  };
}

module.exports = {
  CURRENCY_RATES,
  getCurrencyInfo,
  roundMoney,
  isValidDateString,
  addDays,
  diffNights,
  validateStayDates,
  releaseExpiredHolds,
  getHotelSettings,
  checkSingleRoomAvailability,
  calculateStayPricing,
  findNearbyAvailableDatesForRoom,
  formatRoomRecord,
  searchAvailability,
  getRoomAvailabilityStrip,
  getFrontDeskTapeChart,
  generateRoomIcalFeed,
  importRoomIcalFeed
};
