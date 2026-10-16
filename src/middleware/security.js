const crypto = require('node:crypto');

const CSRF_SECRET = process.env.HOTEL_CSRF_SECRET || 'maison-aurelia-csrf-hmac-key-2026';
const rateLimitBuckets = new Map();

function generateCsrfToken(sessionHint = 'anon') {
  const timestamp = Date.now().toString(36);
  const nonce = crypto.randomBytes(12).toString('hex');
  const payload = `${sessionHint}:${timestamp}:${nonce}`;
  const sig = crypto.createHmac('sha256', CSRF_SECRET).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

function verifyCsrfToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return false;
  try {
    const payload = Buffer.from(encoded, 'base64url').toString('utf8');
    const expectedSig = crypto.createHmac('sha256', CSRF_SECRET).update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'));
  } catch (_) {
    return false;
  }
}

function sanitizeValue(val) {
  if (typeof val === 'string') {
    return val
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/javascript:/gi, '')
      .replace(/on\w+\s*=/gi, '')
      .trim();
  }
  if (Array.isArray(val)) {
    return val.map(sanitizeValue);
  }
  if (val && typeof val === 'object') {
    const cleaned = {};
    for (const [k, v] of Object.entries(val)) {
      cleaned[k] = sanitizeValue(v);
    }
    return cleaned;
  }
  return val;
}

function sanitizeMiddleware(req, _res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeValue(req.body);
  }
  if (req.query && typeof req.query === 'object') {
    for (const [k, v] of Object.entries(req.query)) {
      req.query[k] = sanitizeValue(v);
    }
  }
  next();
}

function securityHeadersMiddleware(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Intentionally do not set X-Frame-Options: DENY so Arena live preview iframe works seamlessly
  next();
}

function csrfProtectionMiddleware(req, res, next) {
  // Safe methods or webhook endpoints (which use HMAC signature verification) skip CSRF token check
  if (
    ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ||
    req.path === '/api/payments/webhook'
  ) {
    return next();
  }

  // Enforce CSRF when client sends x-csrf-token or x-enforce-csrf header
  const token = req.headers['x-csrf-token'] || req.body?._csrf;
  const enforceHeader = req.headers['x-enforce-csrf'];

  if (token) {
    if (!verifyCsrfToken(token)) {
      return res.status(403).json({
        error: 'INVALID_CSRF_TOKEN',
        message: 'Security token validation failed. Please refresh the page and try again.'
      });
    }
  } else if (enforceHeader === '1' || process.env.STRICT_CSRF === '1') {
    return res.status(403).json({
      error: 'CSRF_TOKEN_MISSING',
      message: 'CSRF token is required for state-changing requests.'
    });
  }

  next();
}

function createRateLimiter({ windowMs = 60000, maxRequests = 180 } = {}) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';
    const key = `${ip}:${req.baseUrl || ''}`;
    const now = Date.now();
    let bucket = rateLimitBuckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      rateLimitBuckets.set(key, bucket);
    }
    bucket.count += 1;
    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, maxRequests - bucket.count)));

    if (bucket.count > maxRequests) {
      return res.status(429).json({
        error: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests from this address. Please wait a moment and try again.'
      });
    }
    next();
  };
}

module.exports = {
  generateCsrfToken,
  verifyCsrfToken,
  sanitizeValue,
  sanitizeMiddleware,
  securityHeadersMiddleware,
  csrfProtectionMiddleware,
  createRateLimiter
};
