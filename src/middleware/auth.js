const crypto = require('node:crypto');
const { getDb } = require('../db/database');

const TOKEN_SECRET = process.env.HOTEL_TOKEN_SECRET || 'maison-aurelia-palace-hmac-secret-2026-prod-key';

function hashPassword(password, existingSalt = null) {
  const salt = existingSalt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'));
  } catch (_) {
    return false;
  }
}

function createAuthToken(user) {
  const payload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    name: `${user.first_name} ${user.last_name}`.trim(),
    iat: Date.now(),
    exp: Date.now() + 1000 * 60 * 60 * 24 * 7 // 7 days
  };
  const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(base64Payload)
    .digest('base64url');
  return `${base64Payload}.${sig}`;
}

function verifyAuthToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return null;
  }
  const [base64Payload, sig] = token.split('.');
  if (!base64Payload || !sig) return null;
  const expectedSig = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(base64Payload)
    .digest('base64url');

  try {
    const valid = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
    if (!valid) return null;
    const payload = JSON.parse(Buffer.from(base64Payload, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) {
      return null;
    }
    return payload;
  } catch (_) {
    return null;
  }
}

function extractUserFromRequest(req) {
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  }
  if (!token) return null;
  const decoded = verifyAuthToken(token);
  if (!decoded) return null;
  try {
    const db = getDb();
    const user = db.prepare(
      'SELECT id, email, first_name, last_name, phone, country, role, loyalty_tier, loyalty_points, is_active FROM users WHERE id = ?'
    ).get(decoded.sub);
    if (!user || !user.is_active) return null;
    return user;
  } catch (_) {
    return null;
  }
}

function optionalAuth(req, _res, next) {
  req.user = extractUserFromRequest(req);
  next();
}

function requireAuth(req, res, next) {
  const user = extractUserFromRequest(req);
  if (!user) {
    return res.status(401).json({
      error: 'AUTHENTICATION_REQUIRED',
      message: 'Please sign in to access this resource.'
    });
  }
  req.user = user;
  next();
}

/**
 * Role-Based Access Control (RBAC) middleware
 * Supported roles: 'guest', 'receptionist', 'finance', 'manager', 'admin'
 */
function requireRoles(...allowedRoles) {
  return (req, res, next) => {
    const user = extractUserFromRequest(req);
    if (!user) {
      return res.status(401).json({
        error: 'AUTHENTICATION_REQUIRED',
        message: 'Staff authentication is required for this action.'
      });
    }
    if (!allowedRoles.includes(user.role)) {
      return res.status(403).json({
        error: 'FORBIDDEN_INSUFFICIENT_ROLE',
        message: `Access denied. Your role (${user.role}) does not have permission. Required role(s): ${allowedRoles.join(', ')}.`
      });
    }
    req.user = user;
    next();
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  createAuthToken,
  verifyAuthToken,
  extractUserFromRequest,
  optionalAuth,
  requireAuth,
  requireRoles,
  TOKEN_SECRET
};
