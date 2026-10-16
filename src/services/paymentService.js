const crypto = require('node:crypto');
const { getDb } = require('../db/database');
const { roundMoney } = require('./availabilityService');
const { logAudit } = require('./auditService');

const WEBHOOK_SECRET = process.env.HOTEL_WEBHOOK_SECRET || 'maison-aurelia-webhook-signing-secret-2026';

function detectCardBrand(cardNumber = '') {
  const digits = String(cardNumber).replace(/\D/g, '');
  if (digits.startsWith('4')) return 'Visa Infinite';
  if (/^5[1-5]/.test(digits) || /^2[2-7]/.test(digits)) return 'Mastercard World Elite';
  if (/^3[47]/.test(digits)) return 'American Express Centurion';
  return 'Luxury Privilege Card';
}

/**
 * Tokenises card details so raw card numbers and CVVs are NEVER stored in the database.
 */
function createPaymentToken({ cardNumber, cardholderName, expiryMonth, expiryYear, cvv }) {
  const digits = String(cardNumber || '').replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) {
    const err = new Error('Invalid card number length. Please check your card details.');
    err.code = 'INVALID_CARD_NUMBER';
    throw err;
  }
  if (!cardholderName || String(cardholderName).trim().length < 2) {
    const err = new Error('Cardholder name is required.');
    err.code = 'INVALID_CARDHOLDER';
    throw err;
  }
  if (!cvv || !/^\d{3,4}$/.test(String(cvv))) {
    const err = new Error('Valid 3 or 4 digit security code (CVV) is required.');
    err.code = 'INVALID_CVV';
    throw err;
  }

  const last4 = digits.slice(-4);
  const brand = detectCardBrand(digits);
  const nonce = crypto.randomBytes(8).toString('hex');
  const isDeclineTest = last4 === '0002';

  const tokenPayload = {
    tok: `tok_aur_${nonce}`,
    brand,
    last4,
    holder: String(cardholderName).trim(),
    exp: `${String(expiryMonth).padStart(2, '0')}/${String(expiryYear).slice(-2)}`,
    decline: isDeclineTest,
    iat: Date.now()
  };

  const encoded = Buffer.from(JSON.stringify(tokenPayload)).toString('base64url');
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(encoded).digest('base64url');

  return {
    tokenId: `tok_aur_${encoded}.${sig}`,
    brand,
    last4,
    cardholderName: tokenPayload.holder,
    expiry: tokenPayload.exp
  };
}

function inspectPaymentToken(tokenId) {
  if (!tokenId || typeof tokenId !== 'string') {
    return null;
  }
  if (tokenId === 'tok_decline' || tokenId.endsWith('0002')) {
    return { valid: true, decline: true, brand: 'Visa', last4: '0002' };
  }
  if (tokenId.startsWith('tok_aur_') && tokenId.includes('.')) {
    const raw = tokenId.slice('tok_aur_'.length);
    const [encoded, sig] = raw.split('.');
    const expectedSig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(encoded).digest('base64url');
    if (sig !== expectedSig) {
      return { valid: false };
    }
    try {
      const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      return {
        valid: true,
        decline: Boolean(parsed.decline),
        brand: parsed.brand || 'Visa Infinite',
        last4: parsed.last4 || '4242',
        holder: parsed.holder || ''
      };
    } catch (_) {
      return { valid: false };
    }
  }
  if (tokenId.startsWith('tok_')) {
    return {
      valid: true,
      decline: false,
      brand: 'Visa Infinite',
      last4: '4242'
    };
  }
  return { valid: false };
}

function generatePaymentReference(prefix = 'PAY') {
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${prefix}-AUR-${new Date().getUTCFullYear()}-${rand}`;
}

function generateInvoiceNumber() {
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `INV-${datePart}-${rand}`;
}

/**
 * Verifies payment method and returns gateway verification outcome before atomic booking commit.
 */
function verifyPaymentAuthorization({
  paymentMethod,
  paymentPlan = 'full',
  amountDueNow,
  totalAmount,
  currency = 'USD',
  exchangeRate = 1.0,
  paymentToken = '',
  cardBrand = '',
  cardLast4 = '',
  bankReference = '',
  allowPayAtHotel = true
}) {
  const paymentReference = generatePaymentReference('PAY');
  const invoiceNumber = generateInvoiceNumber();

  if (paymentMethod === 'card') {
    const tokenCheck = inspectPaymentToken(paymentToken);
    if (!tokenCheck || !tokenCheck.valid) {
      const err = new Error('Payment token verification failed. Please tokenise a valid payment card.');
      err.code = 'PAYMENT_TOKEN_INVALID';
      throw err;
    }
    if (tokenCheck.decline) {
      const err = new Error('Your card issuer declined the transaction. No reservation was confirmed and your room hold remains active briefly so you may try another payment method.');
      err.code = 'PAYMENT_DECLINED';
      throw err;
    }

    const chargedAmount = roundMoney(amountDueNow);
    return {
      verified: true,
      paymentReference,
      invoiceNumber,
      paymentMethod: 'card',
      paymentType: paymentPlan === 'deposit' ? 'deposit' : 'charge',
      paymentRecordStatus: 'succeeded',
      reservationPaymentStatus: paymentPlan === 'deposit' ? 'deposit_paid' : 'paid',
      amountPaid: chargedAmount,
      displayCurrency: currency,
      displayAmount: roundMoney(chargedAmount * exchangeRate),
      tokenId: paymentToken.slice(0, 36),
      cardBrand: tokenCheck.brand || cardBrand || 'Visa Infinite',
      cardLast4: tokenCheck.last4 || cardLast4 || '4242',
      bankReference: '',
      verifiedAt: new Date().toISOString()
    };
  }

  if (paymentMethod === 'bank_transfer') {
    if (!bankReference || String(bankReference).trim().length < 4) {
      const err = new Error('Please provide a valid bank transfer / instant wire transaction reference.');
      err.code = 'INVALID_BANK_REFERENCE';
      throw err;
    }
    const chargedAmount = roundMoney(amountDueNow);
    return {
      verified: true,
      paymentReference,
      invoiceNumber,
      paymentMethod: 'bank_transfer',
      paymentType: paymentPlan === 'deposit' ? 'deposit' : 'charge',
      paymentRecordStatus: 'succeeded',
      reservationPaymentStatus: paymentPlan === 'deposit' ? 'deposit_paid' : 'paid',
      amountPaid: chargedAmount,
      displayCurrency: currency,
      displayAmount: roundMoney(chargedAmount * exchangeRate),
      tokenId: '',
      cardBrand: '',
      cardLast4: '',
      bankReference: String(bankReference).trim(),
      verifiedAt: new Date().toISOString()
    };
  }

  if (paymentMethod === 'pay_at_hotel') {
    if (!allowPayAtHotel) {
      const err = new Error('Pay-at-Hotel is currently disabled by hotel management policy.');
      err.code = 'PAY_AT_HOTEL_DISABLED';
      throw err;
    }
    return {
      verified: true,
      paymentReference,
      invoiceNumber,
      paymentMethod: 'pay_at_hotel',
      paymentType: 'authorisation',
      paymentRecordStatus: 'authorised',
      reservationPaymentStatus: 'pay_at_hotel_authorised',
      amountPaid: 0,
      displayCurrency: currency,
      displayAmount: roundMoney(totalAmount * exchangeRate),
      tokenId: paymentToken ? paymentToken.slice(0, 36) : 'GUARANTEE_ON_FILE',
      cardBrand: cardBrand || 'Guarantee on File',
      cardLast4: cardLast4 || '',
      bankReference: '',
      verifiedAt: new Date().toISOString()
    };
  }

  const err = new Error(`Unsupported payment method: ${paymentMethod}`);
  err.code = 'UNSUPPORTED_PAYMENT_METHOD';
  throw err;
}

function signWebhookPayload(payloadObj) {
  const raw = typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj);
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
}

/**
 * Processes a signed payment gateway webhook with cryptographic signature verification
 * and strict idempotency protection so duplicate callbacks never double-book or double-credit.
 */
function processPaymentWebhook({ payload, signatureHeader, ipAddress = '' }) {
  const db = getDb();
  const rawString = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const expectedSig = signWebhookPayload(rawString);

  let signatureValid = false;
  if (signatureHeader && typeof signatureHeader === 'string') {
    try {
      signatureValid = crypto.timingSafeEqual(
        Buffer.from(signatureHeader, 'hex'),
        Buffer.from(expectedSig, 'hex')
      );
    } catch (_) {
      signatureValid = false;
    }
  }

  if (!signatureValid) {
    logAudit({
      eventType: 'WEBHOOK_REJECTED_SIGNATURE',
      entityType: 'payment_webhook',
      entityId: payload?.eventId || 'unknown',
      summary: 'Rejected payment webhook due to invalid HMAC signature.',
      details: { signatureHeader },
      ipAddress
    });
    const err = new Error('Webhook signature verification failed.');
    err.code = 'INVALID_WEBHOOK_SIGNATURE';
    throw err;
  }

  const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const eventId = data.eventId || data.event_id;
  if (!eventId) {
    const err = new Error('Webhook eventId is required.');
    err.code = 'MISSING_EVENT_ID';
    throw err;
  }

  // Idempotency check
  const existingEvent = db.prepare('SELECT * FROM payment_webhooks WHERE event_id = ?').get(eventId);
  if (existingEvent) {
    return {
      processed: false,
      duplicate: true,
      eventId,
      message: 'Webhook event already processed; duplicate ignored safely.'
    };
  }

  db.prepare(`
    INSERT INTO payment_webhooks (event_id, event_type, payment_reference, booking_reference, signature_valid, payload_json)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(
    eventId,
    data.eventType || 'payment.succeeded',
    data.paymentReference || '',
    data.bookingReference || '',
    rawString
  );

  // If webhook confirms balance payment on an existing reservation
  if (data.eventType === 'payment.succeeded' && data.bookingReference) {
    const res = db.prepare('SELECT * FROM reservations WHERE booking_reference = ?').get(data.bookingReference);
    if (res && res.status !== 'cancelled') {
      const amount = roundMoney(Number(data.amount || res.total_amount - res.amount_paid));
      const newAmountPaid = roundMoney(res.amount_paid + amount);
      const newPaymentStatus = newAmountPaid >= res.total_amount ? 'paid' : 'deposit_paid';

      db.prepare(`
        UPDATE reservations
        SET amount_paid = ?, payment_status = ?, status = CASE WHEN status = 'pending_payment' THEN 'confirmed' ELSE status END, updated_at = datetime('now')
        WHERE id = ?
      `).run(newAmountPaid, newPaymentStatus, res.id);

      const payRef = data.paymentReference || generatePaymentReference('WHK');
      const existingPay = db.prepare('SELECT id FROM payments WHERE payment_reference = ?').get(payRef);
      if (!existingPay && amount > 0) {
        db.prepare(`
          INSERT INTO payments (
            payment_reference, invoice_number, reservation_id, booking_reference,
            amount, currency, display_currency, display_amount,
            payment_method, payment_type, status, gateway_response_json, verified_at
          ) VALUES (?, ?, ?, ?, ?, 'USD', ?, ?, 'card', 'balance', 'succeeded', ?, datetime('now'))
        `).run(
          payRef,
          generateInvoiceNumber(),
          res.id,
          res.booking_reference,
          amount,
          res.currency,
          roundMoney(amount * res.exchange_rate),
          rawString
        );
      }
    }
  }

  logAudit({
    eventType: 'WEBHOOK_PROCESSED',
    entityType: 'payment_webhook',
    entityId: eventId,
    summary: `Verified and processed payment webhook ${eventId} (${data.eventType || 'payment.succeeded'}).`,
    details: data,
    ipAddress
  });

  return {
    processed: true,
    duplicate: false,
    eventId,
    message: 'Webhook verified and reconciled.'
  };
}

module.exports = {
  WEBHOOK_SECRET,
  createPaymentToken,
  inspectPaymentToken,
  generatePaymentReference,
  generateInvoiceNumber,
  verifyPaymentAuthorization,
  signWebhookPayload,
  processPaymentWebhook
};
