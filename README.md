# Maison Aurélia Grand Palace & Sanctuary — Luxury Hotel Website & Online Room Reservation System

An end-to-end five-star luxury hotel website, real-time room availability engine, atomic online reservation system, PCI-safe tokenised payment gateway, guest portal, and role-based hotel administration platform.

---

## 1. Key Capabilities & Production Highlights

- **Five-Star Hospitality Brand Experience**:
  - Bespoke visual identity (*Maison Aurélia Grand Palace & Sanctuary*), high-resolution room & suite photography, interactive **3D Isometric Suite & Floorplan Explorer**, multi-currency switcher (`USD`, `EUR`, `GBP`, `CHF`, `AED`, `NGN`), and multilingual support (`EN`, `FR`, `ES`, `AR` with RTL).
  - Explicit **Staging / Sample Inventory Banner** (`STAGING SAMPLE INVENTORY`) clearly labeling pre-configured rooms and allowing instant switching to live production mode in the Admin Dashboard.
- **Complete Hotel Room Catalogue (10 Categories, 17+ Individually Numbered Rooms)**:
  - Pre-configured across all 10 categories: *Standard Rooms, Deluxe Rooms, Superior Rooms, Executive Rooms, Junior Suites, Luxury Suites, Presidential Suites, Family Rooms, Penthouse Suites,* and *Accessible Rooms*.
  - Every room card and detail view displays the room name, physical room number (`#101`, `#201`, `#701`, `#PH-01`), unique identifier (`AUR-RM-101`), category, photo gallery, nightly rate, tax/fee breakdown, maximum occupancy, bed configuration, room dimensions (`m²` and `sq ft`), amenities, hotel facilities, included services, check-in/out policies, and cancellation/refund policies.
- **Real-Time Room Availability Engine**:
  - Evaluates confirmed reservations, active non-expired checkout holds, physical room status, maintenance closures, guest capacity, and same-day turnover rules.
  - Displays exact required status callouts:
    - **Room Available**: *“This room is available for your selected dates. You can proceed with your reservation.”*
    - **Room Unavailable for Selected Dates**: *“Sorry, this room has already been booked or is unavailable for part or all of your selected stay. Please choose different dates or explore other available rooms.”* (with automatic **Alternative Available Rooms** and clickable **Nearby Available Dates**).
- **Database-Level Double-Booking Prevention**:
  - Every hold and reservation confirmation runs inside an atomic `BEGIN IMMEDIATE` SQLite transaction.
  - Enforced at the database engine level by SQLite `BEFORE INSERT` and `BEFORE UPDATE` triggers (`trg_prevent_double_booking_insert`, `trg_prevent_double_booking_update`, `trg_prevent_conflicting_hold_insert`, `trg_prevent_conflicting_maintenance_insert`) that abort any overlapping date range (`check_in < NEW.check_out AND check_out > NEW.check_in`).
- **Expiring Checkout Inventory Holds**:
  - Selecting a room locks the inventory via a temporary checkout hold (`HLD-...`) with a live countdown timer. Expired holds automatically release inventory back to the availability engine.
- **Secure Online Payments & Signed Webhooks**:
  - Supports **Tokenised Card Checkout** (raw card numbers and CVVs are never stored), **Instant Bank Wire Transfer**, and **Authorised Payment-at-Hotel**, with a choice of **100% Full Payment** or **30% Reservation Deposit**.
  - Webhook endpoint (`POST /api/payments/webhook`) verifies `HMAC-SHA256` signatures (`x-payment-signature`) and enforces idempotency via `payment_webhooks(event_id UNIQUE)`.
- **Role-Based Hotel Administration Console (RBAC)**:
  - Separate permissions for `admin`, `manager`, `receptionist`, and `finance` staff roles.
  - Full CRUD for physical rooms and categories, walk-in reservation desk, check-in/check-out workflow, payment confirmation, partial/full refund issuance, maintenance block scheduling, tax/deposit/turnover policy configuration, CSV/JSON report export, immutable audit trail, and hot database backups.

---

## 2. Demo & Staff RBAC Accounts

| Role | Email | Password | Permissions |
| :--- | :--- | :--- | :--- |
| **Administrator (`admin`)** | `admin@maisonaurelia.luxury` | `AureliaAdmin!2026` | Full system access, rooms/categories CRUD, settings, RBAC, backups |
| **Hotel Manager (`manager`)** | `manager@maisonaurelia.luxury` | `AureliaManager!2026` | Rooms/categories CRUD, rates, maintenance, reservations, refunds, reports |
| **Receptionist (`receptionist`)** | `frontdesk@maisonaurelia.luxury` | `AureliaDesk!2026` | View calendar/KPIs, walk-in bookings, check-in/check-out, payment collection |
| **Finance Staff (`finance`)** | `finance@maisonaurelia.luxury` | `AureliaFinance!2026` | Payment confirmation, refunds, taxes/deposits, financial CSV export, audit trail |
| **VIP Guest (`guest`)** | `elena.rostova@example.com` | `GuestPass!2026` | Guest Privé portal, loyalty points, booking history, self-service cancellation |

---

## 3. Running Locally, Testing & Backup Procedures

```bash
# Start the production server (binds to 0.0.0.0:3000 by default)
npm start

# Run the automated end-to-end test suite (availability, concurrency, triggers, holds, payments, RBAC)
npm test

# Verify production build & schema readiness
npm run build

# Create an online hot backup snapshot of the SQLite database (VACUUM INTO backups/)
npm run backup
```

### Disaster Recovery Procedure
1. Hot snapshots are written atomically via SQLite `VACUUM INTO` inside `/backups/maison_aurelia_backup_<timestamp>.db` (either via `npm run backup` or `POST /api/admin/backup`).
2. To restore from a snapshot: stop the server, copy the desired backup `.db` file to `data/maison_aurelia.db` (removing any stale `-wal` or `-shm` files), and restart with `npm start`.
