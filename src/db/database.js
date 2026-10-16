const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

let dbInstance = null;
let currentDbPath = null;

function getDefaultDbPath() {
  if (process.env.HOTEL_DB_PATH) {
    return process.env.HOTEL_DB_PATH;
  }
  const dataDir = path.join(__dirname, '..', '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return path.join(dataDir, 'maison_aurelia.db');
}

function initDatabase(customPath = null) {
  const targetPath = customPath || getDefaultDbPath();
  if (dbInstance && currentDbPath === targetPath) {
    return dbInstance;
  }
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (_) {}
  }

  if (targetPath !== ':memory:') {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new DatabaseSync(targetPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  createSchema(db);

  dbInstance = db;
  currentDbPath = targetPath;
  return db;
}

function getDb() {
  if (!dbInstance) {
    return initDatabase();
  }
  return dbInstance;
}

/**
 * Executes a synchronous callback inside a SQLite BEGIN IMMEDIATE transaction.
 * BEGIN IMMEDIATE acquires a reserved write lock immediately upon starting the
 * transaction, preventing race conditions and concurrent write conflicts.
 */
function withImmediateTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
    const result = fn(db);
    db.exec('COMMIT;');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch (_) {}
    throw err;
  }
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hotel_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      hotel_name TEXT NOT NULL DEFAULT 'Maison Aurélia Grand Palace & Sanctuary',
      brand_tagline TEXT NOT NULL DEFAULT 'Where Heritage Architecture Meets Timeless Hospitality',
      environment_mode TEXT NOT NULL DEFAULT 'staging',
      environment_banner TEXT NOT NULL DEFAULT 'STAGING ENVIRONMENT — Initial Sample Inventory (Configurable via Hotel Admin Dashboard)',
      timezone TEXT NOT NULL DEFAULT 'UTC',
      base_currency TEXT NOT NULL DEFAULT 'USD',
      check_in_time TEXT NOT NULL DEFAULT '15:00',
      check_out_time TEXT NOT NULL DEFAULT '12:00',
      same_day_turnover INTEGER NOT NULL DEFAULT 1,
      tax_rate_percent REAL NOT NULL DEFAULT 12.5,
      service_fee_percent REAL NOT NULL DEFAULT 5.0,
      city_levy_per_night REAL NOT NULL DEFAULT 25.0,
      deposit_percent REAL NOT NULL DEFAULT 30.0,
      hold_duration_minutes INTEGER NOT NULL DEFAULT 10,
      free_cancellation_hours INTEGER NOT NULL DEFAULT 48,
      late_cancellation_penalty_percent REAL NOT NULL DEFAULT 50.0,
      allow_pay_at_hotel INTEGER NOT NULL DEFAULT 1,
      dynamic_yield_enabled INTEGER NOT NULL DEFAULT 1,
      high_demand_occupancy_threshold REAL NOT NULL DEFAULT 75.0,
      high_demand_multiplier REAL NOT NULL DEFAULT 1.15,
      contact_email TEXT NOT NULL DEFAULT 'concierge@maisonaurelia.luxury',
      contact_phone TEXT NOT NULL DEFAULT '+41 22 819 0000',
      address TEXT NOT NULL DEFAULT '18 Quai du Mont-Blanc, Waterfront Sanctuary Quarter',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      country TEXT DEFAULT '',
      role TEXT NOT NULL DEFAULT 'guest' CHECK (role IN ('guest', 'receptionist', 'finance', 'manager', 'admin')),
      loyalty_tier TEXT NOT NULL DEFAULT 'Aurélia Privé' CHECK (loyalty_tier IN ('Aurélia Privé', 'Gold Sanctuary', 'Imperial Black')),
      loyalty_points INTEGER NOT NULL DEFAULT 500,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS room_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      short_description TEXT NOT NULL,
      description TEXT NOT NULL,
      base_price REAL NOT NULL CHECK (base_price > 0),
      max_adults INTEGER NOT NULL DEFAULT 2 CHECK (max_adults >= 1),
      max_children INTEGER NOT NULL DEFAULT 1 CHECK (max_children >= 0),
      max_occupancy INTEGER NOT NULL DEFAULT 3 CHECK (max_occupancy >= 1),
      bed_type TEXT NOT NULL,
      size_sqm INTEGER NOT NULL,
      size_sqft INTEGER NOT NULL,
      hero_image TEXT NOT NULL,
      gallery_json TEXT NOT NULL DEFAULT '[]',
      amenities_json TEXT NOT NULL DEFAULT '[]',
      facilities_json TEXT NOT NULL DEFAULT '[]',
      included_services_json TEXT NOT NULL DEFAULT '[]',
      check_in_policy TEXT NOT NULL,
      check_out_policy TEXT NOT NULL,
      cancellation_policy TEXT NOT NULL,
      refund_policy TEXT NOT NULL,
      floor_plan_svg TEXT DEFAULT '',
      is_featured INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 10,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_number TEXT NOT NULL UNIQUE,
      unique_code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category_id INTEGER NOT NULL REFERENCES room_categories(id) ON DELETE RESTRICT,
      floor INTEGER NOT NULL DEFAULT 1,
      wing TEXT NOT NULL DEFAULT 'Main Palace Wing',
      view_type TEXT NOT NULL DEFAULT 'Courtyard Sanctuary View',
      price_per_night REAL NOT NULL CHECK (price_per_night > 0),
      max_adults INTEGER NOT NULL DEFAULT 2,
      max_children INTEGER NOT NULL DEFAULT 1,
      max_occupancy INTEGER NOT NULL DEFAULT 3,
      bed_type TEXT NOT NULL,
      size_sqm INTEGER NOT NULL,
      size_sqft INTEGER NOT NULL,
      hero_image TEXT NOT NULL,
      gallery_json TEXT NOT NULL DEFAULT '[]',
      amenities_json TEXT NOT NULL DEFAULT '[]',
      facilities_json TEXT NOT NULL DEFAULT '[]',
      included_services_json TEXT NOT NULL DEFAULT '[]',
      check_in_policy TEXT NOT NULL,
      check_out_policy TEXT NOT NULL,
      cancellation_policy TEXT NOT NULL,
      refund_policy TEXT NOT NULL,
      is_accessible INTEGER NOT NULL DEFAULT 0,
      is_sample_inventory INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'maintenance', 'inactive')),
      housekeeping_status TEXT NOT NULL DEFAULT 'clean_inspected' CHECK (housekeeping_status IN ('clean_inspected', 'turndown_complete', 'dirty_turnover', 'deep_cleaning')),
      housekeeping_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS seasonal_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category_id INTEGER REFERENCES room_categories(id) ON DELETE CASCADE,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      multiplier REAL NOT NULL DEFAULT 1.0 CHECK (multiplier > 0),
      badge_text TEXT DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS maintenance_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_by TEXT DEFAULT 'System Admin',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (start_date < end_date)
    );

    CREATE TABLE IF NOT EXISTS room_holds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hold_token TEXT NOT NULL UNIQUE,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      check_in TEXT NOT NULL,
      check_out TEXT NOT NULL,
      guests_adults INTEGER NOT NULL DEFAULT 2,
      guests_children INTEGER NOT NULL DEFAULT 0,
      session_id TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CONVERTED', 'EXPIRED', 'RELEASED')),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (check_in < check_out)
    );

    CREATE TABLE IF NOT EXISTS addons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      price REAL NOT NULL CHECK (price >= 0),
      pricing_type TEXT NOT NULL DEFAULT 'per_stay' CHECK (pricing_type IN ('per_stay', 'per_night', 'per_guest', 'per_guest_per_night')),
      icon TEXT DEFAULT 'sparkles',
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS promo_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE COLLATE NOCASE,
      description TEXT NOT NULL,
      discount_type TEXT NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
      discount_value REAL NOT NULL CHECK (discount_value > 0),
      min_nights INTEGER NOT NULL DEFAULT 1,
      min_amount REAL NOT NULL DEFAULT 0,
      valid_from TEXT NOT NULL,
      valid_until TEXT NOT NULL,
      max_uses INTEGER NOT NULL DEFAULT 1000,
      current_uses INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_reference TEXT NOT NULL UNIQUE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      guest_first_name TEXT NOT NULL,
      guest_last_name TEXT NOT NULL,
      guest_email TEXT NOT NULL,
      guest_phone TEXT NOT NULL,
      guest_country TEXT DEFAULT '',
      special_requests TEXT DEFAULT '',
      check_in TEXT NOT NULL,
      check_out TEXT NOT NULL,
      nights INTEGER NOT NULL CHECK (nights >= 1),
      adults INTEGER NOT NULL CHECK (adults >= 1),
      children INTEGER NOT NULL DEFAULT 0 CHECK (children >= 0),
      rooms_count INTEGER NOT NULL DEFAULT 1 CHECK (rooms_count >= 1),
      status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending_payment', 'confirmed', 'checked_in', 'checked_out', 'cancelled')),
      payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'deposit_paid', 'paid', 'pay_at_hotel_authorised', 'partially_refunded', 'refunded', 'failed')),
      payment_method TEXT NOT NULL DEFAULT 'card' CHECK (payment_method IN ('card', 'bank_transfer', 'pay_at_hotel')),
      payment_plan TEXT NOT NULL DEFAULT 'full' CHECK (payment_plan IN ('full', 'deposit')),
      currency TEXT NOT NULL DEFAULT 'USD',
      exchange_rate REAL NOT NULL DEFAULT 1.0,
      room_subtotal REAL NOT NULL DEFAULT 0,
      seasonal_adjustment REAL NOT NULL DEFAULT 0,
      extras_subtotal REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      promo_code TEXT DEFAULT '',
      tax_amount REAL NOT NULL DEFAULT 0,
      service_fee_amount REAL NOT NULL DEFAULT 0,
      city_levy_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL CHECK (total_amount >= 0),
      amount_due_now REAL NOT NULL DEFAULT 0,
      amount_paid REAL NOT NULL DEFAULT 0,
      refunded_amount REAL NOT NULL DEFAULT 0,
      hold_token TEXT DEFAULT '',
      booking_source TEXT NOT NULL DEFAULT 'online' CHECK (booking_source IN ('online', 'walk_in', 'staff_concierge')),
      booked_by_staff_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      cancelled_at TEXT,
      cancellation_reason TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (check_in < check_out)
    );

    CREATE TABLE IF NOT EXISTS reservation_rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
      room_number TEXT NOT NULL,
      room_name TEXT NOT NULL,
      category_name TEXT NOT NULL,
      check_in TEXT NOT NULL,
      check_out TEXT NOT NULL,
      nightly_rate REAL NOT NULL,
      nights INTEGER NOT NULL,
      room_total REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (check_in < check_out)
    );

    CREATE TABLE IF NOT EXISTS reservation_addons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
      addon_id INTEGER NOT NULL REFERENCES addons(id) ON DELETE RESTRICT,
      addon_code TEXT NOT NULL,
      addon_name TEXT NOT NULL,
      unit_price REAL NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      total_price REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_reference TEXT NOT NULL UNIQUE,
      invoice_number TEXT NOT NULL UNIQUE,
      reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
      booking_reference TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      display_currency TEXT NOT NULL DEFAULT 'USD',
      display_amount REAL NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL CHECK (payment_method IN ('card', 'bank_transfer', 'pay_at_hotel')),
      payment_type TEXT NOT NULL DEFAULT 'charge' CHECK (payment_type IN ('charge', 'deposit', 'balance', 'refund', 'authorisation')),
      token_id TEXT DEFAULT '',
      card_brand TEXT DEFAULT '',
      card_last4 TEXT DEFAULT '',
      bank_reference TEXT DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'authorised', 'failed', 'refunded')),
      gateway_response_json TEXT DEFAULT '{}',
      verified_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payment_webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      payment_reference TEXT NOT NULL,
      booking_reference TEXT DEFAULT '',
      signature_valid INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      processed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notification_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'sms', 'both')),
      subject_template TEXT NOT NULL,
      body_template TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      recipient_email TEXT NOT NULL,
      recipient_phone TEXT DEFAULT '',
      template_code TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'email',
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sent',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      actor_id INTEGER,
      actor_role TEXT DEFAULT 'system',
      actor_email TEXT DEFAULT '',
      summary TEXT NOT NULL,
      details_json TEXT DEFAULT '{}',
      ip_address TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pre_arrival_dossiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reservation_id INTEGER NOT NULL UNIQUE REFERENCES reservations(id) ON DELETE CASCADE,
      booking_reference TEXT NOT NULL UNIQUE,
      pillow_preference TEXT NOT NULL DEFAULT 'Quagliotti Goose Down (Medium-Plush)',
      suite_temperature_c REAL NOT NULL DEFAULT 21.0,
      turndown_scent TEXT NOT NULL DEFAULT 'Grasse Jasmine & White Neroli',
      arrival_transport_mode TEXT NOT NULL DEFAULT 'Rolls-Royce Chauffeur Pickup',
      flight_or_tail_number TEXT DEFAULT '',
      estimated_arrival_time TEXT NOT NULL DEFAULT '15:00',
      dietary_allergies TEXT DEFAULT 'None',
      butler_notes TEXT DEFAULT '',
      digital_key_code TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS folio_charges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
      booking_reference TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'In-Suite Dining',
      description TEXT NOT NULL,
      unit_price REAL NOT NULL CHECK (unit_price >= 0),
      quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
      total_amount REAL NOT NULL CHECK (total_amount >= 0),
      posted_by TEXT DEFAULT 'Front Desk / Concierge',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS guest_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reservation_id INTEGER NOT NULL UNIQUE REFERENCES reservations(id) ON DELETE CASCADE,
      booking_reference TEXT NOT NULL,
      room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
      room_number TEXT NOT NULL,
      guest_name TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
      title TEXT NOT NULL,
      comment TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS facility_bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
      booking_reference TEXT NOT NULL,
      facility_type TEXT NOT NULL CHECK (facility_type IN ('michelin_dining', 'thermal_spa', 'private_cinema', 'yacht_charter')),
      facility_name TEXT NOT NULL,
      reservation_date TEXT NOT NULL,
      slot_time TEXT NOT NULL,
      guests_count INTEGER NOT NULL DEFAULT 2 CHECK (guests_count >= 1),
      treatment_or_menu TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0 CHECK (price >= 0),
      folio_charge_id INTEGER REFERENCES folio_charges(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_res_rooms_lookup ON reservation_rooms(room_id, status, check_in, check_out);
    CREATE INDEX IF NOT EXISTS idx_holds_lookup ON room_holds(room_id, status, expires_at, check_in, check_out);
    CREATE INDEX IF NOT EXISTS idx_maint_lookup ON maintenance_blocks(room_id, status, start_date, end_date);
    CREATE INDEX IF NOT EXISTS idx_reservations_ref ON reservations(booking_reference);
    CREATE INDEX IF NOT EXISTS idx_reservations_email ON reservations(guest_email);

    -- =========================================================================
    -- DATABASE-LEVEL DOUBLE BOOKING & AVAILABILITY EXCLUSION TRIGGERS
    -- =========================================================================

    CREATE TRIGGER IF NOT EXISTS trg_prevent_double_booking_insert
    BEFORE INSERT ON reservation_rooms
    WHEN NEW.status = 'active'
    BEGIN
      SELECT CASE
        WHEN NEW.check_in >= NEW.check_out THEN
          RAISE(ABORT, 'INVALID_DATE_RANGE: Check-out date must be after check-in date.')
        WHEN EXISTS (
          SELECT 1 FROM rooms r
          WHERE r.id = NEW.room_id AND r.status != 'available'
        ) THEN
          RAISE(ABORT, 'ROOM_OUT_OF_SERVICE: Physical room is not in available status.')
        WHEN EXISTS (
          SELECT 1 FROM reservation_rooms rr
          WHERE rr.room_id = NEW.room_id
            AND rr.status = 'active'
            AND rr.check_in < NEW.check_out
            AND rr.check_out > NEW.check_in
        ) THEN
          RAISE(ABORT, 'DOUBLE_BOOKING_CONFLICT: Physical room already has an overlapping active reservation.')
        WHEN EXISTS (
          SELECT 1 FROM maintenance_blocks mb
          WHERE mb.room_id = NEW.room_id
            AND mb.status = 'active'
            AND mb.start_date < NEW.check_out
            AND mb.end_date > NEW.check_in
        ) THEN
          RAISE(ABORT, 'MAINTENANCE_BLOCK_CONFLICT: Physical room is blocked for maintenance during selected dates.')
      END;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_prevent_double_booking_update
    BEFORE UPDATE ON reservation_rooms
    WHEN NEW.status = 'active'
    BEGIN
      SELECT CASE
        WHEN NEW.check_in >= NEW.check_out THEN
          RAISE(ABORT, 'INVALID_DATE_RANGE: Check-out date must be after check-in date.')
        WHEN EXISTS (
          SELECT 1 FROM reservation_rooms rr
          WHERE rr.room_id = NEW.room_id
            AND rr.id != NEW.id
            AND rr.status = 'active'
            AND rr.check_in < NEW.check_out
            AND rr.check_out > NEW.check_in
        ) THEN
          RAISE(ABORT, 'DOUBLE_BOOKING_CONFLICT: Physical room already has an overlapping active reservation.')
        WHEN EXISTS (
          SELECT 1 FROM maintenance_blocks mb
          WHERE mb.room_id = NEW.room_id
            AND mb.status = 'active'
            AND mb.start_date < NEW.check_out
            AND mb.end_date > NEW.check_in
        ) THEN
          RAISE(ABORT, 'MAINTENANCE_BLOCK_CONFLICT: Physical room is blocked for maintenance during selected dates.')
      END;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_prevent_conflicting_hold_insert
    BEFORE INSERT ON room_holds
    WHEN NEW.status = 'ACTIVE'
    BEGIN
      SELECT CASE
        WHEN NEW.check_in >= NEW.check_out THEN
          RAISE(ABORT, 'INVALID_DATE_RANGE: Check-out date must be after check-in date.')
        WHEN EXISTS (
          SELECT 1 FROM rooms r
          WHERE r.id = NEW.room_id AND r.status != 'available'
        ) THEN
          RAISE(ABORT, 'ROOM_OUT_OF_SERVICE: Physical room is not available for holds.')
        WHEN EXISTS (
          SELECT 1 FROM reservation_rooms rr
          WHERE rr.room_id = NEW.room_id
            AND rr.status = 'active'
            AND rr.check_in < NEW.check_out
            AND rr.check_out > NEW.check_in
        ) THEN
          RAISE(ABORT, 'HOLD_CONFLICT_BOOKED: Physical room is already booked for overlapping dates.')
        WHEN EXISTS (
          SELECT 1 FROM maintenance_blocks mb
          WHERE mb.room_id = NEW.room_id
            AND mb.status = 'active'
            AND mb.start_date < NEW.check_out
            AND mb.end_date > NEW.check_in
        ) THEN
          RAISE(ABORT, 'HOLD_CONFLICT_MAINTENANCE: Physical room is under maintenance for overlapping dates.')
        WHEN EXISTS (
          SELECT 1 FROM room_holds rh
          WHERE rh.room_id = NEW.room_id
            AND rh.status = 'ACTIVE'
            AND rh.expires_at > datetime('now')
            AND rh.session_id != NEW.session_id
            AND rh.check_in < NEW.check_out
            AND rh.check_out > NEW.check_in
        ) THEN
          RAISE(ABORT, 'HOLD_CONFLICT_HELD: Physical room is currently held in checkout by another guest.')
      END;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_prevent_conflicting_maintenance_insert
    BEFORE INSERT ON maintenance_blocks
    WHEN NEW.status = 'active'
    BEGIN
      SELECT CASE
        WHEN NEW.start_date >= NEW.end_date THEN
          RAISE(ABORT, 'INVALID_DATE_RANGE: Maintenance end date must be after start date.')
        WHEN EXISTS (
          SELECT 1 FROM reservation_rooms rr
          WHERE rr.room_id = NEW.room_id
            AND rr.status = 'active'
            AND rr.check_in < NEW.end_date
            AND rr.check_out > NEW.start_date
        ) THEN
          RAISE(ABORT, 'MAINTENANCE_CONFLICT_RESERVATION: Cannot block a room that has active confirmed reservations during those dates.')
      END;
    END;
  `);

  // Safe migration for existing databases created prior to housekeeping or dynamic yield columns
  try {
    const cols = db.prepare("PRAGMA table_info('rooms')").all();
    if (!cols.some((c) => c.name === 'housekeeping_status')) {
      db.exec("ALTER TABLE rooms ADD COLUMN housekeeping_status TEXT NOT NULL DEFAULT 'clean_inspected';");
      db.exec("ALTER TABLE rooms ADD COLUMN housekeeping_updated_at TEXT NOT NULL DEFAULT (datetime('now'));");
    }
    const settingCols = db.prepare("PRAGMA table_info('hotel_settings')").all();
    if (!settingCols.some((c) => c.name === 'dynamic_yield_enabled')) {
      db.exec('ALTER TABLE hotel_settings ADD COLUMN dynamic_yield_enabled INTEGER NOT NULL DEFAULT 1;');
      db.exec('ALTER TABLE hotel_settings ADD COLUMN high_demand_occupancy_threshold REAL NOT NULL DEFAULT 75.0;');
      db.exec('ALTER TABLE hotel_settings ADD COLUMN high_demand_multiplier REAL NOT NULL DEFAULT 1.15;');
    }
  } catch (_) {}
}

function backupDatabase(targetBackupPath = null) {
  const db = getDb();
  const backupDir = path.join(__dirname, '..', '..', 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = targetBackupPath || path.join(backupDir, `maison_aurelia_backup_${timestamp}.db`);
  const escapedDest = dest.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escapedDest}';`);
  return {
    backupPath: dest,
    sizeBytes: fs.statSync(dest).size,
    createdAt: new Date().toISOString()
  };
}

module.exports = {
  initDatabase,
  getDb,
  withImmediateTransaction,
  backupDatabase,
  getDefaultDbPath
};
