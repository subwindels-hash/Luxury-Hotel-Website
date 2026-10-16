(function () {
  const SUITE_3D_MODELS = {
    presidential: {
      title: 'The Imperial Presidential Residence (#701)',
      desc: 'Occupying the private 7th-floor noble corner wing with security airlock foyer, 10-seat dining hall, private thermal sauna, and wrap-around waterfront terrace.',
      specs: [
        ['Total Area', '240 m² / 2,583 sq ft'],
        ['Bedrooms', '2 Savoir Royal King Suites'],
        ['Max Occupancy', '6 Guests (4 Adults + 2 Children)'],
        ['Signature Feature', 'In-Suite Sauna, Grand Piano & Security Foyer']
      ],
      zones: [
        { name: 'Master Royal Chamber', dim: '68 m² • King Savoir Bed' },
        { name: 'Formal Reception & Piano Salon', dim: '74 m² • Steinway Grand' },
        { name: '10-Seat Dining & Butler Pantry', dim: '38 m² • Private Chef Entry' },
        { name: 'Calacatta Spa & Private Sauna', dim: '28 m² • Hammam & Tub' },
        { name: 'Ambassador Guest Suite', dim: '20 m² • En-Suite Bath' },
        { name: '270° Waterfront Terrace', dim: '12 m² • Heated Pergola' }
      ]
    },
    penthouse: {
      title: 'Sky Crown Duplex Penthouse (#PH-01)',
      desc: 'Two architectural levels atop Maison Aurélia connected by a sculpted Calacatta marble spiral staircase, crowned by a private heated rooftop infinity plunge pool.',
      specs: [
        ['Total Area', '310 m² / 3,336 sq ft'],
        ['Levels', 'Floors 8 & 9 Duplex + Sky Deck'],
        ['Max Occupancy', '6 Guests'],
        ['Signature Feature', 'Private Heated Rooftop Infinity Plunge Pool']
      ],
      zones: [
        { name: 'Double-Height Sky Atrium', dim: '85 m² • 6m Glass Walls' },
        { name: 'Rooftop Infinity Plunge Pool', dim: '65 m² • Heated 32°C' },
        { name: 'Primary Crown King Suite', dim: '55 m² • Spiral Staircase' },
        { name: 'Outdoor Sky Fireplace & Grill', dim: '40 m² • Teppanyaki Deck' },
        { name: 'Two Guest Sanctuary Suites', dim: '45 m² • En-Suite Baths' },
        { name: 'Grand Cru Wine Vault & Bar', dim: '20 m² • 40 Vintages' }
      ]
    },
    luxury: {
      title: 'Grand Aurélia Salon Suite (#501)',
      desc: 'Heritage European one-bedroom residence featuring double French doors, chevron oak parquetry, fireplace parlor, and panoramic marble soaking bath.',
      specs: [
        ['Total Area', '110 m² / 1,184 sq ft'],
        ['Configuration', 'Separate Parlor + King Bedroom'],
        ['Max Occupancy', '4 Guests (3 Adults + 2 Children)'],
        ['Signature Feature', 'Private Steam Bath & Fireplace Mantel']
      ],
      zones: [
        { name: 'Master King Sanctuary', dim: '40 m² • Savoir No.2 Bed' },
        { name: 'Formal Living Parlor', dim: '36 m² • Marble Fireplace' },
        { name: '6-Seat Dining Alcove', dim: '14 m² • Silver Service' },
        { name: 'Panoramic Soaking Spa Bath', dim: '12 m² • Steam Shower' },
        { name: 'Couture Walk-In Dressing', dim: '5 m² • Valet Closet' },
        { name: 'Guest Powder Room & Foyer', dim: '3 m² • Acoustic Entry' }
      ]
    },
    accessible: {
      title: 'Universal Barrier-Free Sanctuary Suite (#105)',
      desc: 'Engineered with 180cm turning radii, zero-threshold Calacatta marble roll-in spa shower, motorized drapery, and voice/tablet environmental automation.',
      specs: [
        ['Total Area', '62 m² / 667 sq ft'],
        ['Accessibility', 'ADA / ISO Step-Free 120cm Doors'],
        ['Max Occupancy', '3 Guests'],
        ['Signature Feature', 'Zero-Threshold Roll-In Spa & Smart Controls']
      ],
      zones: [
        { name: 'Step-Free King Bedroom', dim: '26 m² • 180cm Turn Radius' },
        { name: 'Roll-In Marble Spa Shower', dim: '14 m² • Teak Fold Bench' },
        { name: 'Companion Lounge & Sofa', dim: '10 m² • Automated Drapes' },
        { name: 'Lowered Vanity & Dressing', dim: '6 m² • Motorized Rails' },
        { name: 'Level-Access Garden Terrace', dim: '4 m² • Zero Threshold' },
        { name: 'Wide Foyer Near Grand Lift', dim: '2 m² • Visual/Tactile Alerts' }
      ]
    }
  };

  const state = {
    lang: 'en',
    currency: 'USD',
    currencies: {
      USD: { code: 'USD', symbol: '$', rate: 1 }
    },
    csrfToken: '',
    sessionId: localStorage.getItem('aurelia_session_id') || ('sess_' + Math.random().toString(36).slice(2, 12)),
    authToken: localStorage.getItem('aurelia_auth_token') || '',
    currentUser: null,
    settings: {},
    addons: [],
    promoCodes: [],
    seasonalRates: [],
    categories: [],
    searchParams: {
      checkIn: '',
      checkOut: '',
      adults: 2,
      children: 0,
      roomsRequired: 1,
      categorySlug: 'all'
    },
    availabilityData: null,
    selectedMultiRoomIds: [],
    activeHold: null,
    holdInterval: null,
    checkoutState: {
      roomIds: [],
      selectedAddons: [],
      promoCode: '',
      paymentPlan: 'full',
      paymentMethod: 'card',
      pricing: null
    },
    currentAdminTab: 'overview'
  };

  localStorage.setItem('aurelia_session_id', state.sessionId);

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatMoney(usdAmount, customCurrency = null) {
    const code = customCurrency || state.currency || 'USD';
    const info = state.currencies[code] || { symbol: '$', rate: 1, code: 'USD' };
    const converted = Number(usdAmount || 0) * Number(info.rate || 1);
    return `${info.symbol}${converted.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })}`;
  }

  async function apiFetch(url, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };
    if (state.csrfToken) {
      headers['x-csrf-token'] = state.csrfToken;
    }
    if (state.authToken) {
      headers.Authorization = `Bearer ${state.authToken}`;
    }

    const res = await fetch(url, {
      ...options,
      headers
    });

    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await res.json() : await res.text();

    if (!res.ok) {
      const err = new Error((data && data.message) || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function setDefaultSearchDates() {
    const now = new Date();
    const checkInDate = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 2);
    const checkOutDate = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 5);

    const inStr = checkInDate.toISOString().slice(0, 10);
    const outStr = checkOutDate.toISOString().slice(0, 10);

    state.searchParams.checkIn = inStr;
    state.searchParams.checkOut = outStr;

    const inEl = document.getElementById('searchCheckIn');
    const outEl = document.getElementById('searchCheckOut');
    if (inEl) inEl.value = inStr;
    if (outEl) outEl.value = outStr;
  }

  async function init() {
    setDefaultSearchDates();
    select3dSuite('presidential');

    try {
      const cfg = await apiFetch('/api/config');
      state.settings = cfg.settings || {};
      state.currencies = cfg.currencies || state.currencies;
      state.addons = cfg.addons || [];
      state.promoCodes = cfg.promoCodes || [];
      state.seasonalRates = cfg.seasonalRates || [];
      state.csrfToken = cfg.csrfToken || '';

      updateEnvironmentBanner();
    } catch (err) {
      console.error('Failed to load config:', err);
    }

    if (state.authToken) {
      try {
        const me = await apiFetch('/api/auth/me');
        state.currentUser = me.user;
      } catch (_) {
        state.authToken = '';
        localStorage.removeItem('aurelia_auth_token');
      }
    }

    await performAvailabilitySearch();
  }

  function updateEnvironmentBanner() {
    const badge = document.getElementById('envModeBadge');
    const text = document.getElementById('envBannerText');
    if (!badge || !text) return;

    if (state.settings.environment_mode === 'production') {
      badge.textContent = 'PRODUCTION LIVE INVENTORY';
      badge.style.borderColor = '#4ade80';
      badge.style.color = '#4ade80';
    } else {
      badge.textContent = 'STAGING SAMPLE INVENTORY';
    }
    text.textContent = state.settings.environment_banner || '';
  }

  function setLanguage(lang) {
    state.lang = lang;
    const dict = (window.AURELIA_I18N && window.AURELIA_I18N[lang]) || window.AURELIA_I18N.en;
    document.documentElement.lang = lang;
    document.documentElement.dir = dict.dir || 'ltr';

    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (dict[key]) {
        el.textContent = dict[key];
      }
    });
    renderCatalogue();
  }

  async function setCurrency(currencyCode) {
    state.currency = currencyCode;
    await performAvailabilitySearch();
    if (!document.getElementById('checkoutModal').classList.contains('hidden')) {
      await refreshCheckoutPricing();
    }
  }

  function switchView(viewName) {
    ['home', 'reviews', 'contact', 'lookup', 'portal', 'admin'].forEach((v) => {
      const el = document.getElementById(`view-${v}`);
      if (el) el.classList.toggle('hidden', v !== viewName);
    });

    document.querySelectorAll('.nav-link[data-view]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-view') === viewName);
    });

    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (viewName === 'reviews') {
      renderReviewsPage();
    } else if (viewName === 'contact') {
      initContactPage();
    } else if (viewName === 'portal') {
      renderGuestPortal();
    } else if (viewName === 'admin') {
      ensureStaffForAdminAndLoad();
    }
  }

  function scrollToSection(sectionId) {
    switchView('home');
    setTimeout(() => {
      const el = document.getElementById(sectionId);
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    }, 80);
  }

  // -------------------------------------------------------------------------
  // Real-Time Availability Search & Catalogue Rendering
  // -------------------------------------------------------------------------

  async function handleSearchSubmit(e) {
    if (e) e.preventDefault();
    state.searchParams.checkIn = document.getElementById('searchCheckIn').value;
    state.searchParams.checkOut = document.getElementById('searchCheckOut').value;
    state.searchParams.adults = Number(document.getElementById('searchAdults').value || 2);
    state.searchParams.children = Number(document.getElementById('searchChildren').value || 0);
    state.searchParams.roomsRequired = Number(document.getElementById('searchRoomsCount').value || 1);
    state.searchParams.categorySlug = document.getElementById('searchCategory').value || 'all';

    await performAvailabilitySearch();
    const catSec = document.getElementById('catalogueSection');
    if (catSec) catSec.scrollIntoView({ behavior: 'smooth' });
  }

  async function performAvailabilitySearch() {
    try {
      const data = await apiFetch('/api/availability/search', {
        method: 'POST',
        body: JSON.stringify({
          ...state.searchParams,
          currency: state.currency,
          sessionId: state.sessionId
        })
      });
      state.availabilityData = data;
      state.categories = data.categories || [];
      populateCategoryDropdownAndPills();
      renderCatalogue();
    } catch (err) {
      const grid = document.getElementById('roomsCatalogueGrid');
      if (grid) {
        grid.innerHTML = `
          <div class="availability-box is-unavailable" style="grid-column:1 / -1;">
            <div class="availability-box-heading">Search Validation Error</div>
            <p>${escapeHtml(err.message)}</p>
          </div>
        `;
      }
    }
  }

  function populateCategoryDropdownAndPills() {
    const select = document.getElementById('searchCategory');
    const pills = document.getElementById('categoryPillsContainer');
    if (!select || !pills || !state.availabilityData) return;

    const currentSlug = state.searchParams.categorySlug || 'all';
    select.innerHTML = `<option value="all">All Categories (${state.categories.length})</option>` +
      state.categories.map((c) => `
        <option value="${escapeHtml(c.slug)}" ${c.slug === currentSlug ? 'selected' : ''}>
          ${escapeHtml(c.name)} (${c.availablePhysicalRoomsCount}/${c.totalPhysicalRooms} avail)
        </option>
      `).join('');

    const totalAvail = state.availabilityData.totalAvailableRoomsCount;
    pills.innerHTML = `
      <button type="button" class="category-pill ${currentSlug === 'all' ? 'active' : ''}" onclick="window.AureliaApp.filterByCategory('all')">
        All Rooms &amp; Suites (${totalAvail} Available)
      </button>
      ${state.categories.map((c) => `
        <button type="button" class="category-pill ${currentSlug === c.slug ? 'active' : ''}" onclick="window.AureliaApp.filterByCategory('${escapeHtml(c.slug)}')">
          ${escapeHtml(c.name)} (${c.availablePhysicalRoomsCount}/${c.totalPhysicalRooms})
        </button>
      `).join('')}
    `;
  }

  async function filterByCategory(slug) {
    state.searchParams.categorySlug = slug;
    const select = document.getElementById('searchCategory');
    if (select) select.value = slug;
    await performAvailabilitySearch();
  }

  function renderCatalogue() {
    const grid = document.getElementById('roomsCatalogueGrid');
    const sub = document.getElementById('searchSummarySubtitle');
    const tray = document.getElementById('multiRoomTray');
    if (!grid || !state.availabilityData) return;

    const { searchParams, rooms, totalAvailableRoomsCount } = state.availabilityData;
    if (sub) {
      sub.innerHTML = `Showing live database inventory for <strong>${escapeHtml(searchParams.checkIn)}</strong> to <strong>${escapeHtml(searchParams.checkOut)}</strong> (${searchParams.nights} night${searchParams.nights > 1 ? 's' : ''}) • <strong>${searchParams.adults} Adult${searchParams.adults > 1 ? 's' : ''}</strong>, <strong>${searchParams.children} Child${searchParams.children === 1 ? '' : 'ren'}</strong> • <strong>${totalAvailableRoomsCount}</strong> physical room(s) available.`;
    }

    // Multi-room selection bar visibility
    if (tray) {
      const showTray = searchParams.roomsRequired > 1 || state.selectedMultiRoomIds.length > 0;
      tray.classList.toggle('hidden', !showTray);
      if (showTray) {
        const trayText = document.getElementById('multiRoomTrayText');
        const bookBtn = document.getElementById('multiRoomBookBtn');
        trayText.textContent = `Selected ${state.selectedMultiRoomIds.length} of ${Math.max(searchParams.roomsRequired, state.selectedMultiRoomIds.length)} requested room(s).`;
        bookBtn.disabled = state.selectedMultiRoomIds.length === 0;
      }
    }

    if (!rooms || rooms.length === 0) {
      grid.innerHTML = `<p style="grid-column:1/-1;text-align:center;padding:2rem;">No rooms configured in this category.</p>`;
      return;
    }

    grid.innerHTML = rooms.map((room) => {
      const isSelectedMulti = state.selectedMultiRoomIds.includes(room.id);
      const p = room.pricing;

      let availabilitySectionHtml = '';
      if (room.isAvailable) {
        availabilitySectionHtml = `
          <div class="availability-box is-available">
            <div class="availability-box-heading">
              <span>✓ ${escapeHtml(room.availabilityHeading)}</span>
              <span style="font-size:0.75rem;">${p.nights} Night${p.nights > 1 ? 's' : ''}</span>
            </div>
            <p>${escapeHtml(room.availabilityMessage)}</p>
            <div class="stay-total-summary">
              <span>Total Stay (incl. ${formatMoney(p.taxAmount + p.serviceFeeAmount + p.cityLevyAmount)} taxes &amp; fees):</span>
              <span class="stay-total-amount">${formatMoney(p.totalAmount)}</span>
            </div>
          </div>
        `;
      } else {
        const nearbyBtns = (room.nearbyAvailableDates || []).map((nd) => `
          <button type="button" class="nearby-date-btn" onclick="window.AureliaApp.applySuggestedDates('${nd.checkIn}', '${nd.checkOut}')">
            ${nd.checkIn} &rarr; ${nd.checkOut}
          </button>
        `).join('');

        const altRoomsHtml = (room.alternativeRooms && room.alternativeRooms.length > 0)
          ? `<div style="margin-top:0.45rem;font-size:0.75rem;">
               <strong>Alternative Available Rooms:</strong>
               ${room.alternativeRooms.map((ar) => `
                 <a href="#room-card-${ar.id}" style="color:var(--crimson-err);text-decoration:underline;margin-right:0.5rem;">
                   #${escapeHtml(ar.roomNumber)} ${escapeHtml(ar.name)} (${formatMoney(ar.totalStayPrice)})
                 </a>
               `).join('')}
             </div>`
          : '';

        availabilitySectionHtml = `
          <div class="availability-box is-unavailable">
            <div class="availability-box-heading">
              <span>✕ ${escapeHtml(room.availabilityHeading)}</span>
            </div>
            <p>${escapeHtml(room.availabilityMessage)}</p>
            ${room.conflictDetails ? `<p style="font-size:0.74rem;margin-top:0.25rem;opacity:0.85;">Status detail: ${escapeHtml(room.conflictDetails)}</p>` : ''}
            ${nearbyBtns ? `<div class="nearby-dates-list"><strong>Nearby Available Dates for #${escapeHtml(room.roomNumber)}:</strong><br/>${nearbyBtns}</div>` : ''}
            ${altRoomsHtml}
          </div>
        `;
      }

      return `
        <article class="room-card" id="room-card-${room.id}">
          <div class="room-card-media">
            <img src="${escapeHtml(room.heroImage)}" alt="${escapeHtml(room.name)}" loading="lazy" />
            <div class="room-badges-top">
              <span class="badge-category">${escapeHtml(room.categoryName)}</span>
              <span class="badge-room-number">Room #${escapeHtml(room.roomNumber)} • ${escapeHtml(room.uniqueCode)}</span>
            </div>
            <div class="room-price-overlay">
              <div>
                <span style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.08em;color:#e2dccf;display:block;">
                  Floor ${room.floor} • ${escapeHtml(room.wing)}
                </span>
                ${room.isSampleInventory ? '<span style="font-size:0.66rem;background:rgba(212,175,99,0.28);color:#f9e3b0;padding:0.1rem 0.4rem;border-radius:3px;">Sample Inventory (Admin Configurable)</span>' : '<span style="font-size:0.66rem;background:rgba(23,107,71,0.5);color:#bbf7d0;padding:0.1rem 0.4rem;border-radius:3px;">Live Custom Room</span>'}
              </div>
              <div class="price-per-night">
                ${formatMoney(room.pricePerNight)} <span>/ night</span>
              </div>
            </div>
          </div>

          <div class="room-card-body">
            <h3 class="room-card-title">${escapeHtml(room.name)}</h3>
            <div class="room-meta-line">
              <span>📍 ${escapeHtml(room.viewType)}</span>
            </div>

            <div class="room-specs-grid">
              <div class="room-spec-item">
                <span>Capacity</span>
                <strong>Up to ${room.maxOccupancy} Guests</strong>
              </div>
              <div class="room-spec-item">
                <span>Bed Configuration</span>
                <strong>${escapeHtml(room.bedType.split('+')[0])}</strong>
              </div>
              <div class="room-spec-item">
                <span>Suite Dimensions</span>
                <strong>${room.sizeSqm} m² (${room.sizeSqft} ft²)</strong>
              </div>
            </div>

            <div class="amenities-chips">
              ${(room.amenities || []).slice(0, 4).map((a) => `<span class="amenity-chip">${escapeHtml(a)}</span>`).join('')}
            </div>

            ${availabilitySectionHtml}

            <div class="room-card-actions">
              <button type="button" class="btn-secondary" onclick="window.AureliaApp.openRoomDetailModal(${room.id})">
                Inspect &amp; Policies
              </button>
              ${room.isAvailable ? `
                <button type="button" class="btn-primary" onclick="window.AureliaApp.initiateBookingForRooms([${room.id}])">
                  Book This Room
                </button>
                <button type="button" class="btn-secondary" style="flex:0 0 auto;padding:0.7rem;" title="Add/Remove for Multi-Room Booking" onclick="window.AureliaApp.toggleMultiRoomSelection(${room.id})">
                  ${isSelectedMulti ? '✓ Selected' : '+ Multi'}
                </button>
              ` : `
                <button type="button" class="btn-primary" disabled>
                  Unavailable
                </button>
              `}
            </div>
          </div>
        </article>
      `;
    }).join('');
  }

  async function applySuggestedDates(checkIn, checkOut) {
    state.searchParams.checkIn = checkIn;
    state.searchParams.checkOut = checkOut;
    document.getElementById('searchCheckIn').value = checkIn;
    document.getElementById('searchCheckOut').value = checkOut;
    await performAvailabilitySearch();
  }

  function toggleMultiRoomSelection(roomId) {
    const idx = state.selectedMultiRoomIds.indexOf(roomId);
    if (idx >= 0) {
      state.selectedMultiRoomIds.splice(idx, 1);
    } else {
      state.selectedMultiRoomIds.push(roomId);
    }
    renderCatalogue();
  }

  function clearMultiRoomSelection() {
    state.selectedMultiRoomIds = [];
    renderCatalogue();
  }

  function startMultiRoomCheckout() {
    if (state.selectedMultiRoomIds.length === 0) return;
    initiateBookingForRooms([...state.selectedMultiRoomIds]);
  }

  // -------------------------------------------------------------------------
  // Room Detail, Photo Gallery & Policies Modal
  // -------------------------------------------------------------------------

  async function openRoomDetailModal(roomId) {
    try {
      const q = new URLSearchParams({
        checkIn: state.searchParams.checkIn,
        checkOut: state.searchParams.checkOut,
        adults: state.searchParams.adults,
        children: state.searchParams.children,
        currency: state.currency,
        sessionId: state.sessionId
      });
      const data = await apiFetch(`/api/rooms/${roomId}?${q.toString()}`);
      const r = data.room;
      const av = data.availability;

      document.getElementById('roomModalCategory').textContent = `${r.categoryName} • Room #${r.roomNumber} (${r.uniqueCode})`;
      document.getElementById('roomModalTitle').textContent = r.name;

      const body = document.getElementById('roomModalBody');
      body.innerHTML = `
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:0.75rem;margin-bottom:1.5rem;">
          <img id="roomGalleryPrimary" src="${escapeHtml(r.heroImage)}" alt="${escapeHtml(r.name)}" style="width:100%;height:320px;object-fit:cover;border-radius:var(--radius-md);" />
          <div style="display:flex;flex-direction:column;gap:0.5rem;">
            ${(r.gallery || [r.heroImage]).map((imgUrl) => `
              <img src="${escapeHtml(imgUrl)}" alt="Suite gallery thumbnail" style="width:100%;height:100px;object-fit:cover;border-radius:var(--radius-sm);cursor:pointer;border:2px solid var(--gold-primary);" onclick="document.getElementById('roomGalleryPrimary').src='${escapeHtml(imgUrl)}'" />
            `).join('')}
          </div>
        </div>

        <div class="room-specs-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:1.5rem;">
          <div class="room-spec-item"><span>Nightly Rate</span><strong>${formatMoney(r.pricePerNight)} / night</strong></div>
          <div class="room-spec-item"><span>Max Capacity</span><strong>${r.maxOccupancy} Guests (${r.maxAdults} Adults, ${r.maxChildren} Children)</strong></div>
          <div class="room-spec-item"><span>Bed Type</span><strong>${escapeHtml(r.bedType)}</strong></div>
          <div class="room-spec-item"><span>Dimensions &amp; Wing</span><strong>${r.sizeSqm} m² (${r.sizeSqft} sq ft) • Floor ${r.floor}</strong></div>
        </div>

        ${av ? `
          <div class="availability-box ${av.available ? 'is-available' : 'is-unavailable'}" style="margin-bottom:1.5rem;">
            <div class="availability-box-heading">
              <span>${av.available ? '✓' : '✕'} ${escapeHtml(av.heading)} (${escapeHtml(state.searchParams.checkIn)} to ${escapeHtml(state.searchParams.checkOut)})</span>
              ${av.pricing ? `<span class="stay-total-amount">${formatMoney(av.pricing.totalAmount)} Total Stay</span>` : ''}
            </div>
            <p>${escapeHtml(av.message)}</p>
          </div>
        ` : ''}

        <div class="checkout-columns" style="margin-bottom:1.5rem;">
          <div>
            <h4 style="font-family:var(--font-serif);font-size:1.25rem;margin-bottom:0.5rem;">Suite Amenities &amp; Included Services</h4>
            <ul style="padding-left:1.2rem;font-size:0.86rem;margin-bottom:1rem;">
              ${(r.amenities || []).map((a) => `<li>${escapeHtml(a)}</li>`).join('')}
            </ul>
            <h5 style="font-size:0.8rem;text-transform:uppercase;color:var(--gold-primary);margin-bottom:0.35rem;">Complimentary Included Services</h5>
            <ul style="padding-left:1.2rem;font-size:0.84rem;margin-bottom:1rem;">
              ${(r.includedServices || []).map((s) => `<li>${escapeHtml(s)}</li>`).join('')}
            </ul>
            <h5 style="font-size:0.8rem;text-transform:uppercase;color:var(--gold-primary);margin-bottom:0.35rem;">Hotel Facilities Access</h5>
            <ul style="padding-left:1.2rem;font-size:0.84rem;">
              ${(r.facilities || []).map((f) => `<li>${escapeHtml(f)}</li>`).join('')}
            </ul>
          </div>

          <div class="price-summary-card" style="position:static;">
            <h4 style="font-family:var(--font-serif);font-size:1.25rem;margin-bottom:0.65rem;">Check-In, Cancellation &amp; Refund Policies</h4>
            <p style="font-size:0.82rem;margin-bottom:0.6rem;"><strong>Check-In Policy:</strong> ${escapeHtml(r.checkInPolicy)}</p>
            <p style="font-size:0.82rem;margin-bottom:0.6rem;"><strong>Check-Out Policy:</strong> ${escapeHtml(r.checkOutPolicy)}</p>
            <p style="font-size:0.82rem;margin-bottom:0.6rem;"><strong>Cancellation Policy:</strong> ${escapeHtml(r.cancellationPolicy)}</p>
            <p style="font-size:0.82rem;margin-bottom:0.8rem;"><strong>Refund Policy:</strong> ${escapeHtml(r.refundPolicy)}</p>

            ${data.unavailableRanges && data.unavailableRanges.length > 0 ? `
              <div style="border-top:1px solid var(--border-subtle);padding-top:0.6rem;font-size:0.78rem;">
                <strong>Scheduled Unavailable Dates for #${escapeHtml(r.roomNumber)}:</strong>
                <ul style="padding-left:1rem;margin-top:0.25rem;">
                  ${data.unavailableRanges.map((ur) => `<li>${escapeHtml(ur.startDate)} to ${escapeHtml(ur.endDate)} (${escapeHtml(ur.type)})</li>`).join('')}
                </ul>
              </div>
            ` : '<p style="font-size:0.78rem;color:var(--emerald-ok);">✓ No upcoming maintenance closures or conflicting blocks on calendar.</p>'}
          </div>
        </div>

        ${data.availabilityStrip && data.availabilityStrip.strip ? `
          <div style="margin-bottom:1.5rem;border-top:1px solid var(--border-subtle);padding-top:1rem;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.65rem;flex-wrap:wrap;gap:0.5rem;">
              <h4 style="font-family:var(--font-serif);font-size:1.25rem;">14-Day Live Rate &amp; Availability Ribbon (Click any available date to set Check-In)</h4>
              <a href="/api/rooms/${r.id}/calendar.ics" target="_blank" class="btn-secondary" style="text-decoration:none;padding:0.35rem 0.75rem;font-size:0.76rem;">
                📅 Export iCal Feed (.ics)
              </a>
            </div>
            <div class="availability-strip-grid">
              ${data.availabilityStrip.strip.map((day) => `
                <div class="strip-day-card ${day.available ? 'day-avail' : 'day-unavail'}" onclick="window.AureliaApp.applySuggestedDates('${day.date}', '${day.nextDate}'); window.AureliaApp.closeRoomDetailModal();" title="${day.available ? 'Click to select check-in ' + day.date : escapeHtml(day.statusReason)}">
                  <strong style="display:block;font-size:0.74rem;">${escapeHtml(day.date.slice(5))}</strong>
                  <span style="display:block;font-weight:700;margin-top:0.15rem;">${day.available ? escapeHtml(day.currencySymbol) + day.displayRate.toLocaleString() : 'Booked'}</span>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}

        ${data.reviews && data.reviews.length > 0 ? `
          <div style="margin-bottom:1.5rem;border-top:1px solid var(--border-subtle);padding-top:1rem;">
            <h4 style="font-family:var(--font-serif);font-size:1.25rem;margin-bottom:0.65rem;">Verified Guest Reviews for Room #${escapeHtml(r.roomNumber)}</h4>
            ${data.reviews.map((rv) => `
              <div style="background:var(--bg-ivory);padding:0.75rem;border-radius:6px;margin-bottom:0.5rem;font-size:0.84rem;">
                <div style="display:flex;justify-content:space-between;">
                  <strong>${'★'.repeat(rv.rating)}${'☆'.repeat(5 - rv.rating)} — ${escapeHtml(rv.title)}</strong>
                  <span style="font-size:0.75rem;color:var(--text-muted);">${escapeHtml(rv.guest_name)} (Verified Booking <code>${escapeHtml(rv.booking_reference)}</code>)</span>
                </div>
                <p style="margin-top:0.3rem;color:#334155;">${escapeHtml(rv.comment)}</p>
              </div>
            `).join('')}
          </div>
        ` : ''}

        <div style="display:flex;justify-content:flex-end;gap:0.75rem;flex-wrap:wrap;">
          <button type="button" class="btn-secondary" onclick="window.AureliaApp.closeRoomDetailModal()">Close</button>
          ${av && av.available ? `
            <button type="button" class="btn-primary" onclick="window.AureliaApp.closeRoomDetailModal(); window.AureliaApp.initiateBookingForRooms([${r.id}]);">
              Book This Room (#${escapeHtml(r.roomNumber)})
            </button>
          ` : `
            <button type="button" class="btn-primary" onclick="window.AureliaApp.promptJoinRoomWaitlist(${r.id}, '${escapeHtml(r.roomNumber)}')">
              🔔 Join Priority Waitlist for These Dates
            </button>
          `}
          ` : ''}
        </div>
      `;

      document.getElementById('roomDetailModal').classList.remove('hidden');
    } catch (err) {
      alert(err.message);
    }
  }

  function closeRoomDetailModal() {
    document.getElementById('roomDetailModal').classList.add('hidden');
  }

  // -------------------------------------------------------------------------
  // 3D Suite Architecture Visualizer
  // -------------------------------------------------------------------------

  function select3dSuite(key, btnEl = null) {
    const model = SUITE_3D_MODELS[key] || SUITE_3D_MODELS.presidential;
    if (btnEl) {
      document.querySelectorAll('#suite3dButtons .category-pill').forEach((b) => b.classList.remove('active'));
      btnEl.classList.add('active');
    }

    const titleEl = document.getElementById('suite3dTitle');
    const descEl = document.getElementById('suite3dDesc');
    const specsEl = document.getElementById('suite3dSpecs');
    const plateEl = document.getElementById('floorplan3dPlate');

    if (titleEl) titleEl.textContent = model.title;
    if (descEl) descEl.textContent = model.desc;
    if (specsEl) {
      specsEl.innerHTML = model.specs.map(([label, val]) => `
        <div style="background:rgba(255,255,255,0.05);border:1px solid rgba(212,175,99,0.25);padding:0.65rem;border-radius:6px;">
          <span style="font-size:0.7rem;text-transform:uppercase;color:var(--gold-bright);display:block;">${escapeHtml(label)}</span>
          <strong style="font-size:0.88rem;color:#fff;">${escapeHtml(val)}</strong>
        </div>
      `).join('');
    }
    if (plateEl) {
      plateEl.innerHTML = model.zones.map((z) => `
        <div class="floorplan-zone">
          <strong>${escapeHtml(z.name)}</strong>
          <span>${escapeHtml(z.dim)}</span>
        </div>
      `).join('');
    }
  }

  function update3dPerspective() {
    const x = document.getElementById('tiltXSlider').value;
    const z = document.getElementById('tiltZSlider').value;
    const plate = document.getElementById('floorplan3dPlate');
    if (plate) {
      plate.style.transform = `rotateX(${x}deg) rotateZ(${z}deg)`;
    }
  }

  // -------------------------------------------------------------------------
  // Step 5–8: Expiring Checkout Hold & Atomic Reservation Checkout
  // -------------------------------------------------------------------------

  async function initiateBookingForRooms(roomIds) {
    try {
      const holdRes = await apiFetch('/api/holds', {
        method: 'POST',
        body: JSON.stringify({
          roomIds,
          checkIn: state.searchParams.checkIn,
          checkOut: state.searchParams.checkOut,
          adults: state.searchParams.adults,
          children: state.searchParams.children,
          sessionId: state.sessionId
        })
      });

      state.activeHold = holdRes;
      state.checkoutState = {
        roomIds: holdRes.roomIds,
        selectedAddons: [],
        promoCode: '',
        paymentPlan: 'full',
        paymentMethod: 'card',
        pricing: holdRes.pricing
      };

      startHoldCountdownTimer();
      renderCheckoutModal();
      document.getElementById('checkoutModal').classList.remove('hidden');
      await performAvailabilitySearch();
    } catch (err) {
      alert(err.message);
      await performAvailabilitySearch();
    }
  }

  function startHoldCountdownTimer() {
    if (state.holdInterval) clearInterval(state.holdInterval);
    const bar = document.getElementById('activeHoldBar');
    const tokDisplay = document.getElementById('activeHoldTokenDisplay');
    const countEl = document.getElementById('activeHoldCountdown');

    if (!state.activeHold) {
      if (bar) bar.classList.add('hidden');
      return;
    }

    if (bar) bar.classList.remove('hidden');
    if (tokDisplay) tokDisplay.textContent = state.activeHold.holdToken;

    const updateTick = () => {
      if (!state.activeHold) return;
      const expMs = new Date(state.activeHold.expiresAt.replace(' ', 'T')).getTime();
      const diffSec = Math.max(0, Math.floor((expMs - Date.now()) / 1000));
      const mins = String(Math.floor(diffSec / 60)).padStart(2, '0');
      const secs = String(diffSec % 60).padStart(2, '0');
      const formatted = `${mins}:${secs}`;

      if (countEl) countEl.textContent = formatted;
      const modalTimer = document.getElementById('checkoutModalHoldTimer');
      if (modalTimer) modalTimer.textContent = formatted;

      if (diffSec <= 0) {
        clearInterval(state.holdInterval);
        state.activeHold = null;
        if (bar) bar.classList.add('hidden');
        performAvailabilitySearch();
      }
    };

    updateTick();
    state.holdInterval = setInterval(updateTick, 1000);
  }

  async function cancelActiveHold() {
    if (!state.activeHold) return;
    try {
      await apiFetch(`/api/holds/${state.activeHold.holdToken}?sessionId=${encodeURIComponent(state.sessionId)}`, {
        method: 'DELETE'
      });
    } catch (_) {}
    state.activeHold = null;
    if (state.holdInterval) clearInterval(state.holdInterval);
    document.getElementById('activeHoldBar').classList.add('hidden');
    document.getElementById('checkoutModal').classList.add('hidden');
    await performAvailabilitySearch();
  }

  function reopenCheckoutModal() {
    if (!state.activeHold) return;
    renderCheckoutModal();
    document.getElementById('checkoutModal').classList.remove('hidden');
  }

  function closeCheckoutModal() {
    document.getElementById('checkoutModal').classList.add('hidden');
  }

  async function refreshCheckoutPricing() {
    try {
      const res = await apiFetch('/api/pricing/calculate', {
        method: 'POST',
        body: JSON.stringify({
          roomIds: state.checkoutState.roomIds,
          checkIn: state.searchParams.checkIn,
          checkOut: state.searchParams.checkOut,
          adults: state.searchParams.adults,
          children: state.searchParams.children,
          selectedAddons: state.checkoutState.selectedAddons,
          promoCode: state.checkoutState.promoCode,
          redeemLoyaltyPoints: Boolean(state.checkoutState.redeemLoyaltyPoints),
          paymentPlan: state.checkoutState.paymentPlan,
          currency: state.currency
        })
      });
      state.checkoutState.pricing = res.pricing;
      updateCheckoutPriceSummaryDOM();
    } catch (err) {
      console.error('Pricing refresh error:', err);
    }
  }

  function renderCheckoutModal() {
    const body = document.getElementById('checkoutModalBody');
    const user = state.currentUser;
    const p = state.checkoutState.pricing;

    body.innerHTML = `
      <div class="availability-box is-available" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.75rem;margin-bottom:1.5rem;">
        <div>
          <strong>Temporary Inventory Hold Active (<code>${escapeHtml(state.activeHold?.holdToken || '')}</code>)</strong>
          <p style="font-size:0.8rem;">Your selected physical room(s) are locked exclusively for your session while you complete checkout.</p>
        </div>
        <div style="text-align:right;">
          <span style="font-size:0.72rem;text-transform:uppercase;display:block;">Hold Expires In</span>
          <strong id="checkoutModalHoldTimer" style="font-size:1.3rem;font-family:monospace;">10:00</strong>
        </div>
      </div>

      <form id="checkoutConfirmForm" onsubmit="window.AureliaApp.submitAtomicReservation(event)">
        <div class="checkout-columns">
          <!-- Left Column: Guest Info, Luxury Extras, Promo & Payment Gateway -->
          <div>
            <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin-bottom:0.75rem;">1. Primary Guest Details</h4>
            <div class="form-grid-2">
              <div class="form-group">
                <label for="chkFirstName">First Name *</label>
                <input type="text" id="chkFirstName" value="${escapeHtml(user ? user.first_name : 'Alexander')}" required />
              </div>
              <div class="form-group">
                <label for="chkLastName">Last Name *</label>
                <input type="text" id="chkLastName" value="${escapeHtml(user ? user.last_name : 'Sterling')}" required />
              </div>
            </div>
            <div class="form-grid-2">
              <div class="form-group">
                <label for="chkEmail">Email Address (for Confirmation &amp; Invoice) *</label>
                <input type="email" id="chkEmail" value="${escapeHtml(user ? user.email : 'alexander.sterling@example.com')}" required />
              </div>
              <div class="form-group">
                <label for="chkPhone">Mobile / WhatsApp Number *</label>
                <input type="tel" id="chkPhone" value="${escapeHtml(user ? user.phone : '+41 22 555 0144')}" required />
              </div>
            </div>
            <div class="form-grid-2">
              <div class="form-group">
                <label for="chkCountry">Country / Residence</label>
                <input type="text" id="chkCountry" value="${escapeHtml(user ? user.country : 'Switzerland')}" />
              </div>
              <div class="form-group">
                <label for="chkSpecialRequests">Concierge &amp; Arrival Preferences</label>
                <input type="text" id="chkSpecialRequests" placeholder="e.g., Hypoallergenic pillows, 16:00 arrival..." />
              </div>
            </div>

            <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin:1.25rem 0 0.75rem;">2. Enhance Your Stay (Optional Luxury Extras)</h4>
            <div>
              ${state.addons.map((addon) => {
                const checked = state.checkoutState.selectedAddons.includes(addon.code);
                return `
                  <label class="addon-option-row">
                    <div style="display:flex;gap:0.65rem;align-items:flex-start;">
                      <input type="checkbox" value="${escapeHtml(addon.code)}" ${checked ? 'checked' : ''} onchange="window.AureliaApp.toggleCheckoutAddon('${escapeHtml(addon.code)}', this.checked)" style="margin-top:0.25rem;" />
                      <div>
                        <strong style="font-size:0.88rem;display:block;">${escapeHtml(addon.name)}</strong>
                        <span style="font-size:0.78rem;color:var(--text-muted);">${escapeHtml(addon.description)}</span>
                      </div>
                    </div>
                    <div style="white-space:nowrap;font-weight:700;font-size:0.84rem;color:var(--gold-primary);">
                      +${formatMoney(addon.price)}
                      <span style="display:block;font-size:0.68rem;color:var(--text-muted);text-align:right;">${escapeHtml(addon.pricing_type.replace(/_/g, ' '))}</span>
                    </div>
                  </label>
                `;
              }).join('')}
            </div>

            <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin:1.25rem 0 0.75rem;">3. Payment Plan &amp; Secure Payment Gateway</h4>
            <div class="form-grid-2" style="margin-bottom:1rem;">
              <label class="addon-option-row" style="margin-bottom:0;">
                <div>
                  <input type="radio" name="paymentPlanRadio" value="full" ${state.checkoutState.paymentPlan === 'full' ? 'checked' : ''} onchange="window.AureliaApp.setCheckoutPaymentPlan('full')" />
                  <strong style="margin-left:0.35rem;">Full Stay Payment (100%)</strong>
                  <p style="font-size:0.75rem;color:var(--text-muted);margin-top:0.2rem;">Settle complete stay total online now.</p>
                </div>
              </label>
              <label class="addon-option-row" style="margin-bottom:0;">
                <div>
                  <input type="radio" name="paymentPlanRadio" value="deposit" ${state.checkoutState.paymentPlan === 'deposit' ? 'checked' : ''} onchange="window.AureliaApp.setCheckoutPaymentPlan('deposit')" />
                  <strong style="margin-left:0.35rem;">${p.depositPercent}% Reservation Deposit</strong>
                  <p style="font-size:0.75rem;color:var(--text-muted);margin-top:0.2rem;">Pay ${p.depositPercent}% now, balance upon arrival.</p>
                </div>
              </label>
            </div>

            <div style="display:flex;gap:0.5rem;margin-bottom:1rem;">
              <button type="button" class="category-pill ${state.checkoutState.paymentMethod === 'card' ? 'active' : ''}" onclick="window.AureliaApp.setCheckoutPaymentMethod('card')">
                💳 Tokenised Credit / Debit Card
              </button>
              <button type="button" class="category-pill ${state.checkoutState.paymentMethod === 'bank_transfer' ? 'active' : ''}" onclick="window.AureliaApp.setCheckoutPaymentMethod('bank_transfer')">
                🏦 Instant Bank Wire Transfer
              </button>
              <button type="button" class="category-pill ${state.checkoutState.paymentMethod === 'pay_at_hotel' ? 'active' : ''}" onclick="window.AureliaApp.setCheckoutPaymentMethod('pay_at_hotel')">
                🏨 Authorised Pay-at-Hotel
              </button>
            </div>

            <div id="paymentGatewayFieldsContainer"></div>
          </div>

          <!-- Right Column: Authoritative Price Breakdown & Policy -->
          <div>
            <div class="price-summary-card">
              <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin-bottom:0.75rem;">Reservation Price Breakdown</h4>
              <div id="checkoutPriceBreakdownBox"></div>

              <!-- Promotional Code Box -->
              <div style="margin-top:1rem;padding-top:0.85rem;border-top:1px dashed var(--border-subtle);">
                <label style="font-size:0.74rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);display:block;margin-bottom:0.35rem;">
                  Promotional or Privilege Code (Try <code>AURELIA10</code> or <code>ROYALSUITE15</code>)
                </label>
                <div style="display:flex;gap:0.5rem;">
                  <input type="text" id="chkPromoInput" value="${escapeHtml(state.checkoutState.promoCode)}" placeholder="Enter promo code" style="flex:1;padding:0.5rem 0.7rem;border:1px solid #d4cab4;border-radius:4px;" />
                  <button type="button" class="btn-secondary" style="padding:0.5rem 0.85rem;" onclick="window.AureliaApp.applyCheckoutPromo()">Apply</button>
                </div>
              </div>

              <!-- LoyaltyPointsCheckoutRedemptionModule UI -->
              ${state.currentUser && Number(state.currentUser.loyalty_points || 0) >= 10 ? `
                <div style="margin-top:0.85rem;padding:0.75rem;background:var(--gold-pale);border:1px solid var(--gold-primary);border-radius:6px;font-size:0.8rem;">
                  <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;font-weight:700;">
                    <input type="checkbox" ${state.checkoutState.redeemLoyaltyPoints ? 'checked' : ''} onchange="window.AureliaApp.toggleCheckoutLoyaltyRedemption(this.checked)" />
                    <span>✨ Redeem ${state.currentUser.loyalty_points.toLocaleString()} Aurélia Loyalty Points (10 pts = $1.00 USD Credit)</span>
                  </label>
                </div>
              ` : ''}

              <div style="margin-top:1rem;padding:0.75rem;background:#ffffff;border-radius:6px;border:1px solid var(--border-subtle);font-size:0.76rem;color:var(--text-muted);">
                <strong>Cancellation &amp; Refund Guarantee:</strong><br />
                Complimentary cancellation up to ${state.settings.free_cancellation_hours || 48} hours prior to check-in (15:00). Availability is re-verified atomically before payment capture.
              </div>

              <div id="checkoutErrorAlert" class="availability-box is-unavailable hidden" style="margin-top:1rem;"></div>

              <button type="submit" id="confirmBookingSubmitBtn" class="btn-primary" style="width:100%;margin-top:1rem;padding:0.95rem;">
                Verify Payment &amp; Confirm Reservation Atomically
              </button>
            </div>
          </div>
        </div>
      </form>
    `;

    renderPaymentMethodFields();
    updateCheckoutPriceSummaryDOM();
  }

  function renderPaymentMethodFields() {
    const container = document.getElementById('paymentGatewayFieldsContainer');
    if (!container) return;

    const method = state.checkoutState.paymentMethod;
    if (method === 'card') {
      container.innerHTML = `
        <div style="background:#f8fafc;border:1px solid #e2e8f0;padding:1.1rem;border-radius:var(--radius-sm);">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;flex-wrap:wrap;gap:0.5rem;">
            <span style="font-size:0.78rem;font-weight:700;color:#1e293b;">🔒 PCI-DSS Tokenised Card Vault (Raw card numbers never stored)</span>
            <div style="display:flex;gap:0.4rem;">
              <button type="button" class="nearby-date-btn" style="border-color:var(--emerald-ok);color:var(--emerald-ok);" onclick="window.AureliaApp.fillTestCard('valid')">Fill Valid Visa (4242)</button>
              <button type="button" class="nearby-date-btn" onclick="window.AureliaApp.fillTestCard('decline')">Test Declined Card (0002)</button>
            </div>
          </div>
          <div class="form-grid-2">
            <div class="form-group">
              <label for="cardHolderInput">Cardholder Name *</label>
              <input type="text" id="cardHolderInput" value="ALEXANDER STERLING" required />
            </div>
            <div class="form-group">
              <label for="cardNumberInput">Card Number *</label>
              <input type="text" id="cardNumberInput" value="4532 0151 1283 4242" maxlength="23" required />
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.75rem;">
            <div class="form-group" style="margin-bottom:0;">
              <label for="cardExpMonth">Expiry Month *</label>
              <input type="text" id="cardExpMonth" value="08" maxlength="2" required />
            </div>
            <div class="form-group" style="margin-bottom:0;">
              <label for="cardExpYear">Expiry Year *</label>
              <input type="text" id="cardExpYear" value="2029" maxlength="4" required />
            </div>
            <div class="form-group" style="margin-bottom:0;">
              <label for="cardCvv">Security Code (CVV) *</label>
              <input type="password" id="cardCvv" value="884" maxlength="4" required />
            </div>
          </div>
        </div>
      `;
    } else if (method === 'bank_transfer') {
      container.innerHTML = `
        <div style="background:#f8fafc;border:1px solid #e2e8f0;padding:1.1rem;border-radius:var(--radius-sm);">
          <p style="font-size:0.82rem;margin-bottom:0.75rem;">
            <strong>Maison Aurélia Treasury Wire Details:</strong><br />
            IBAN: <code>CH93 0076 2011 6238 5295 7</code> • BIC/SWIFT: <code>AURECHGGXXX</code>
          </p>
          <div class="form-group" style="margin-bottom:0;">
            <label for="bankRefInput">Instant Wire / Local Transfer Reference Number *</label>
            <input type="text" id="bankRefInput" value="BNK-WIRE-994821" required />
          </div>
        </div>
      `;
    } else {
      container.innerHTML = `
        <div style="background:#f8fafc;border:1px solid #e2e8f0;padding:1.1rem;border-radius:var(--radius-sm);font-size:0.84rem;">
          <strong>Authorised Payment-at-Hotel Option Selected:</strong>
          <p style="color:var(--text-muted);margin-top:0.3rem;">
            Your reservation will be confirmed immediately with an authorised guarantee on file. Full settlement is completed at our private reception desk upon arrival.
          </p>
        </div>
      `;
    }
  }

  function fillTestCard(type) {
    const numEl = document.getElementById('cardNumberInput');
    if (!numEl) return;
    numEl.value = type === 'decline' ? '4000 0000 0000 0002' : '4532 0151 1283 4242';
  }

  async function toggleCheckoutAddon(code, isChecked) {
    const list = state.checkoutState.selectedAddons;
    if (isChecked && !list.includes(code)) {
      list.push(code);
    } else if (!isChecked) {
      state.checkoutState.selectedAddons = list.filter((c) => c !== code);
    }
    await refreshCheckoutPricing();
  }

  async function setCheckoutPaymentPlan(plan) {
    state.checkoutState.paymentPlan = plan;
    await refreshCheckoutPricing();
  }

  function setCheckoutPaymentMethod(method) {
    state.checkoutState.paymentMethod = method;
    renderCheckoutModal();
  }

  async function applyCheckoutPromo() {
    const input = document.getElementById('chkPromoInput');
    state.checkoutState.promoCode = input ? input.value.trim() : '';
    await refreshCheckoutPricing();
  }

  async function toggleCheckoutLoyaltyRedemption(isChecked) {
    state.checkoutState.redeemLoyaltyPoints = Boolean(isChecked);
    await refreshCheckoutPricing();
  }

  async function promptJoinRoomWaitlist(roomId, roomNumber) {
    const guestName = state.currentUser
      ? `${state.currentUser.first_name} ${state.currentUser.last_name}`
      : prompt(`Enter your full name to join the Priority Waitlist for Room #${roomNumber}:`, 'Lady Eleanor Vance');
    if (!guestName) return;
    const guestEmail = state.currentUser
      ? state.currentUser.email
      : prompt('Enter your email address for instant availability release alerts:', 'eleanor.vance@example.com');
    if (!guestEmail) return;

    try {
      const res = await apiFetch('/api/waitlist', {
        method: 'POST',
        body: JSON.stringify({
          roomId,
          guestName,
          guestEmail,
          checkIn: state.searchParams.checkIn,
          checkOut: state.searchParams.checkOut,
          adults: state.searchParams.adults,
          children: state.searchParams.children,
          notes: `Priority alert requested for Room #${roomNumber}`
        })
      });
      alert(
        `✓ Priority Waitlist Confirmed!\nReference: ${res.waitlistEntry.waitlist_reference}\nYou will be notified immediately if Room #${roomNumber} becomes available for ${state.searchParams.checkIn} → ${state.searchParams.checkOut}.`
      );
    } catch (err) {
      alert(err.message);
    }
  }

  function updateCheckoutPriceSummaryDOM() {
    const box = document.getElementById('checkoutPriceBreakdownBox');
    if (!box || !state.checkoutState.pricing) return;
    const p = state.checkoutState.pricing;

    box.innerHTML = `
      <div style="margin-bottom:0.75rem;padding-bottom:0.65rem;border-bottom:1px solid var(--border-subtle);font-size:0.83rem;">
        <div><strong>Dates:</strong> ${escapeHtml(p.checkIn)} &rarr; ${escapeHtml(p.checkOut)} (${p.nights} night${p.nights > 1 ? 's' : ''})</div>
        <div><strong>Occupancy:</strong> ${p.adults} Adult(s), ${p.children} Child(ren)</div>
      </div>

      ${p.roomBreakdowns.map((rb) => `
        <div class="price-line">
          <span>#${escapeHtml(rb.roomNumber)} ${escapeHtml(rb.roomName)} (${rb.nights}n × ${formatMoney(rb.effectiveNightlyRate)})</span>
          <strong>${formatMoney(rb.roomTotal)}</strong>
        </div>
      `).join('')}

      ${p.addonBreakdowns.map((ab) => `
        <div class="price-line">
          <span>+ ${escapeHtml(ab.name)} (${escapeHtml(ab.multiplierDesc)})</span>
          <strong>${formatMoney(ab.totalPrice)}</strong>
        </div>
      `).join('')}

      ${p.appliedPromo ? `
        <div class="price-line" style="color:var(--emerald-ok);font-weight:700;">
          <span>Promo (${escapeHtml(p.appliedPromo.code)})</span>
          <span>-${formatMoney(p.discountAmount)}</span>
        </div>
      ` : ''}

      ${p.loyaltyDiscountAmount > 0 ? `
        <div class="price-line" style="color:var(--emerald-ok);font-weight:700;">
          <span>Loyalty Points Redeemed (${p.loyaltyPointsRedeemed} pts)</span>
          <span>-${formatMoney(p.loyaltyDiscountAmount)}</span>
        </div>
      ` : ''}

      <div class="price-line">
        <span>Hospitality VAT &amp; Luxury Tax (${p.taxRatePercent}%)</span>
        <span>${formatMoney(p.taxAmount)}</span>
      </div>
      <div class="price-line">
        <span>Service Charge (${p.serviceFeePercent}%)</span>
        <span>${formatMoney(p.serviceFeeAmount)}</span>
      </div>
      <div class="price-line">
        <span>City Sanctuary Levy (${formatMoney(p.cityLevyPerNight)}/night/room)</span>
        <span>${formatMoney(p.cityLevyAmount)}</span>
      </div>

      <div class="price-line total">
        <span>Total Stay Price</span>
        <span>${formatMoney(p.totalAmount)}</span>
      </div>

      <div style="margin-top:0.65rem;padding:0.65rem;background:var(--emerald-bg);border-radius:6px;display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:0.82rem;font-weight:700;color:var(--emerald-ok);">
          ${state.checkoutState.paymentMethod === 'pay_at_hotel' ? 'Authorised for Pay-at-Hotel:' : p.paymentPlan === 'deposit' ? `Due Now (${p.depositPercent}% Deposit):` : 'Amount Due Now (100%):'}
        </span>
        <strong style="font-size:1.1rem;color:var(--emerald-ok);">
          ${state.checkoutState.paymentMethod === 'pay_at_hotel' ? formatMoney(0) : formatMoney(p.amountDueNow)}
        </strong>
      </div>
    `;
  }

  async function submitAtomicReservation(e) {
    e.preventDefault();
    const errBox = document.getElementById('checkoutErrorAlert');
    const submitBtn = document.getElementById('confirmBookingSubmitBtn');
    if (errBox) errBox.classList.add('hidden');
    if (submitBtn) submitBtn.disabled = true;

    try {
      let paymentToken = '';
      let cardBrand = '';
      let cardLast4 = '';
      let bankReference = '';

      if (state.checkoutState.paymentMethod === 'card') {
        const tokenRes = await apiFetch('/api/payments/tokenise', {
          method: 'POST',
          body: JSON.stringify({
            cardholderName: document.getElementById('cardHolderInput').value,
            cardNumber: document.getElementById('cardNumberInput').value,
            expiryMonth: document.getElementById('cardExpMonth').value,
            expiryYear: document.getElementById('cardExpYear').value,
            cvv: document.getElementById('cardCvv').value
          })
        });
        paymentToken = tokenRes.tokenId;
        cardBrand = tokenRes.brand;
        cardLast4 = tokenRes.last4;
      } else if (state.checkoutState.paymentMethod === 'bank_transfer') {
        bankReference = document.getElementById('bankRefInput').value;
      } else {
        paymentToken = 'tok_pay_at_hotel_guarantee';
      }

      const bookingRes = await apiFetch('/api/bookings', {
        method: 'POST',
        body: JSON.stringify({
          roomIds: state.checkoutState.roomIds,
          checkIn: state.searchParams.checkIn,
          checkOut: state.searchParams.checkOut,
          adults: state.searchParams.adults,
          children: state.searchParams.children,
          guestFirstName: document.getElementById('chkFirstName').value,
          guestLastName: document.getElementById('chkLastName').value,
          guestEmail: document.getElementById('chkEmail').value,
          guestPhone: document.getElementById('chkPhone').value,
          guestCountry: document.getElementById('chkCountry').value,
          specialRequests: document.getElementById('chkSpecialRequests').value,
          selectedAddons: state.checkoutState.selectedAddons,
          promoCode: state.checkoutState.promoCode,
          redeemLoyaltyPoints: Boolean(state.checkoutState.redeemLoyaltyPoints),
          paymentMethod: state.checkoutState.paymentMethod,
          paymentPlan: state.checkoutState.paymentPlan,
          paymentToken,
          cardBrand,
          cardLast4,
          bankReference,
          currency: state.currency,
          holdToken: state.activeHold ? state.activeHold.holdToken : '',
          sessionId: state.sessionId
        })
      });

      // Clear active hold banner
      state.activeHold = null;
      state.selectedMultiRoomIds = [];
      if (state.holdInterval) clearInterval(state.holdInterval);
      document.getElementById('activeHoldBar').classList.add('hidden');
      closeCheckoutModal();

      // Open instant confirmation & invoice modal
      showConfirmationModal(bookingRes.reservation);
      await performAvailabilitySearch();
    } catch (err) {
      if (errBox) {
        errBox.classList.remove('hidden');
        errBox.innerHTML = `
          <div class="availability-box-heading">✕ Checkout Verification Alert</div>
          <p>${escapeHtml(err.message)}</p>
        `;
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  // -------------------------------------------------------------------------
  // Step 9: Instant Confirmation & Official Printable Tax Invoice Modal
  // -------------------------------------------------------------------------

  function showConfirmationModal(reservation) {
    const modal = document.getElementById('confirmationModal');
    const body = document.getElementById('confirmationModalBody');
    if (!modal || !body || !reservation) return;

    const latestPayment = (reservation.payments && reservation.payments[0]) || {};

    body.innerHTML = `
      <div style="border:2px solid var(--gold-primary);border-radius:var(--radius-md);padding:1.75rem;background:#ffffff;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:1rem;border-bottom:1px solid var(--border-subtle);padding-bottom:1.25rem;margin-bottom:1.25rem;">
          <div>
            <span class="section-eyebrow" style="margin-bottom:0.2rem;">MAISON AURÉLIA GRAND PALACE &amp; SANCTUARY</span>
            <h4 style="font-family:var(--font-serif);font-size:1.75rem;">Official Booking Confirmation &amp; Invoice</h4>
            <p style="font-size:0.82rem;color:var(--text-muted);">18 Quai du Mont-Blanc • concierge@maisonaurelia.luxury</p>
          </div>
          <div style="text-align:right;">
            <span style="font-size:0.72rem;text-transform:uppercase;color:var(--text-muted);display:block;">Booking Reference</span>
            <strong style="font-size:1.45rem;font-family:monospace;color:var(--bg-obsidian);background:var(--gold-pale);padding:0.2rem 0.6rem;border-radius:4px;">
              ${escapeHtml(reservation.booking_reference)}
            </strong>
            <span style="display:block;font-size:0.76rem;color:var(--emerald-ok);font-weight:700;margin-top:0.3rem;">
              Status: ${escapeHtml(reservation.status.toUpperCase())} • ${escapeHtml(reservation.payment_status.toUpperCase())}
            </span>
          </div>
        </div>

        <div class="form-grid-2" style="margin-bottom:1.25rem;font-size:0.86rem;">
          <div>
            <strong>Registered Guest:</strong><br />
            ${escapeHtml(reservation.guest_first_name)} ${escapeHtml(reservation.guest_last_name)}<br />
            ${escapeHtml(reservation.guest_email)} • ${escapeHtml(reservation.guest_phone)}<br />
            ${escapeHtml(reservation.guest_country || '')}
          </div>
          <div>
            <strong>Stay Schedule &amp; Invoice Details:</strong><br />
            Check-In: <strong>${escapeHtml(reservation.check_in)}</strong> (from 15:00)<br />
            Check-Out: <strong>${escapeHtml(reservation.check_out)}</strong> (until 12:00) • ${reservation.nights} Night(s)<br />
            Invoice #: <code>${escapeHtml(latestPayment.invoice_number || 'INV-GENERATED')}</code> • Payment Ref: <code>${escapeHtml(latestPayment.payment_reference || '')}</code>
          </div>
        </div>

        <div class="data-table-wrapper" style="margin-bottom:1.25rem;">
          <table class="data-table">
            <thead>
              <tr>
                <th>Reserved Suite / Physical Room</th>
                <th>Category</th>
                <th>Dates</th>
                <th>Nightly Rate</th>
                <th>Line Total (USD)</th>
              </tr>
            </thead>
            <tbody>
              ${(reservation.rooms || []).map((rm) => `
                <tr>
                  <td><strong>#${escapeHtml(rm.room_number)}</strong> — ${escapeHtml(rm.room_name)}</td>
                  <td>${escapeHtml(rm.category_name)}</td>
                  <td>${escapeHtml(rm.check_in)} &rarr; ${escapeHtml(rm.check_out)} (${rm.nights}n)</td>
                  <td>$${Number(rm.nightly_rate).toFixed(2)}</td>
                  <td><strong>$${Number(rm.room_total).toFixed(2)}</strong></td>
                </tr>
              `).join('')}
              ${(reservation.addons || []).map((ad) => `
                <tr>
                  <td colspan="3">+ Optional Luxury Extra: ${escapeHtml(ad.addon_name)}</td>
                  <td>$${Number(ad.unit_price).toFixed(2)}</td>
                  <td><strong>$${Number(ad.total_price).toFixed(2)}</strong></td>
                </tr>
              `).join('')}
              ${(reservation.folioCharges || []).map((fc) => `
                <tr>
                  <td colspan="3">+ In-Stay Folio (${escapeHtml(fc.category)}): ${escapeHtml(fc.description)} × ${fc.quantity}</td>
                  <td>$${Number(fc.unit_price).toFixed(2)}</td>
                  <td><strong>$${Number(fc.total_amount).toFixed(2)}</strong></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:1.25rem;">
          ${reservation.preArrivalDossier ? `
            <div style="background:var(--bg-obsidian);color:#fff;padding:1rem 1.25rem;border-radius:8px;border:1px solid var(--gold-primary);max-width:410px;font-size:0.78rem;">
              <span style="color:var(--gold-bright);font-weight:700;text-transform:uppercase;letter-spacing:0.08em;display:block;margin-bottom:0.25rem;">
                🔑 Digital Check-In Pass &amp; Butler Dossier
              </span>
              <code style="font-size:1.05rem;color:#86efac;display:block;margin-bottom:0.4rem;">${escapeHtml(reservation.preArrivalDossier.digital_key_code)}</code>
              <div><strong>Pillow:</strong> ${escapeHtml(reservation.preArrivalDossier.pillow_preference)}</div>
              <div><strong>Climate &amp; Scent:</strong> ${reservation.preArrivalDossier.suite_temperature_c}°C • ${escapeHtml(reservation.preArrivalDossier.turndown_scent)}</div>
              <div><strong>Arrival Logistics:</strong> ${escapeHtml(reservation.preArrivalDossier.arrival_transport_mode)} (${escapeHtml(reservation.preArrivalDossier.estimated_arrival_time)})</div>
            </div>
          ` : '<div></div>'}

          <div style="width:100%;max-width:360px;font-size:0.85rem;">
            <div class="price-line"><span>Rooms &amp; Seasonal Rate:</span><span>$${Number(reservation.room_subtotal + reservation.seasonal_adjustment).toFixed(2)} USD</span></div>
            <div class="price-line"><span>Optional Extras:</span><span>$${Number(reservation.extras_subtotal).toFixed(2)} USD</span></div>
            ${reservation.discount_amount > 0 ? `<div class="price-line" style="color:var(--emerald-ok);"><span>Promo Discount (${escapeHtml(reservation.promo_code)}):</span><span>-$${Number(reservation.discount_amount).toFixed(2)} USD</span></div>` : ''}
            <div class="price-line"><span>Taxes, Service Fee &amp; City Levy:</span><span>$${Number(reservation.tax_amount + reservation.service_fee_amount + reservation.city_levy_amount).toFixed(2)} USD</span></div>
            ${reservation.incidentalTotal > 0 ? `<div class="price-line"><span>In-Stay Folio Incidentals:</span><span>$${Number(reservation.incidentalTotal).toFixed(2)} USD</span></div>` : ''}
            <div class="price-line total"><span>Grand Folio Total:</span><span>$${Number(reservation.grandFolioTotal || reservation.total_amount).toFixed(2)} USD</span></div>
            <div class="price-line" style="color:var(--emerald-ok);font-weight:700;"><span>Verified Paid:</span><span>$${Number(reservation.amount_paid).toFixed(2)} USD</span></div>
            <div class="price-line"><span>Remaining Balance Due:</span><span>$${Number(reservation.remainingFolioBalance !== undefined ? reservation.remainingFolioBalance : Math.max(0, reservation.total_amount - reservation.amount_paid)).toFixed(2)} USD</span></div>
          </div>
        </div>

        <div class="no-print" style="margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--border-subtle);display:flex;justify-content:space-between;flex-wrap:wrap;gap:0.75rem;">
          <button type="button" class="btn-secondary" onclick="window.print()">🖨️ Print / Save Official PDF Invoice</button>
          <div style="display:flex;gap:0.5rem;">
            <button type="button" class="btn-secondary" onclick="window.AureliaApp.closeConfirmationModal(); window.AureliaApp.openBookingInLookup('${escapeHtml(reservation.booking_reference)}', '${escapeHtml(reservation.guest_email)}');">
              Manage or Cancel Reservation
            </button>
            <button type="button" class="btn-primary" onclick="window.AureliaApp.closeConfirmationModal()">
              Done
            </button>
          </div>
        </div>
      </div>
    `;

    modal.classList.remove('hidden');
  }

  function closeConfirmationModal() {
    document.getElementById('confirmationModal').classList.add('hidden');
  }

  function openBookingInLookup(ref, email) {
    switchView('lookup');
    document.getElementById('lookupRefInput').value = ref;
    document.getElementById('lookupEmailInput').value = email;
    handleLookupSubmit();
  }

  // -------------------------------------------------------------------------
  // View 2: Guest Booking Lookup, Invoice & Self-Service Cancellation
  // -------------------------------------------------------------------------

  async function handleLookupSubmit(e) {
    if (e) e.preventDefault();
    const ref = document.getElementById('lookupRefInput').value.trim();
    const email = document.getElementById('lookupEmailInput').value.trim();
    const container = document.getElementById('lookupResultContainer');

    try {
      const data = await apiFetch(`/api/bookings/lookup?bookingReference=${encodeURIComponent(ref)}&email=${encodeURIComponent(email)}`);
      renderLookupReservationCard(data.reservation, container, email);
    } catch (err) {
      container.innerHTML = `
        <div class="availability-box is-unavailable">
          <div class="availability-box-heading">Reservation Lookup Failed</div>
          <p>${escapeHtml(err.message)}</p>
        </div>
      `;
    }
  }

  function renderLookupReservationCard(res, container, verificationEmail = '') {
    const canCancel = res.status !== 'cancelled' && res.status !== 'checked_out';

    container.innerHTML = `
      <div class="price-summary-card" style="position:static;background:#ffffff;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem;margin-bottom:1rem;border-bottom:1px solid var(--border-subtle);padding-bottom:1rem;">
          <div>
            <span class="status-pill ${escapeHtml(res.status)}">${escapeHtml(res.status)}</span>
            <span class="status-pill ${escapeHtml(res.payment_status)}" style="margin-left:0.35rem;">${escapeHtml(res.payment_status)}</span>
            <h3 style="font-family:var(--font-serif);font-size:1.65rem;margin-top:0.35rem;">
              Booking Reference: <code>${escapeHtml(res.booking_reference)}</code>
            </h3>
          </div>
          <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
            <a href="/api/bookings/${encodeURIComponent(res.booking_reference)}/invoice?format=html" target="_blank" class="btn-secondary" style="text-decoration:none;display:inline-flex;align-items:center;">
              🖨️ Official Tax &amp; Folio Invoice
            </a>
            <button type="button" class="btn-secondary" onclick='window.AureliaApp.showConfirmationModal(${JSON.stringify(res).replace(/'/g, "&#39;")})'>
              View Printable Invoice
            </button>
            ${canCancel ? `
              <button type="button" class="btn-danger" onclick="window.AureliaApp.promptCancelReservation('${escapeHtml(res.booking_reference)}', '${escapeHtml(verificationEmail || res.guest_email)}')">
                Cancel Reservation &amp; Request Refund
              </button>
            ` : ''}
          </div>
        </div>

        <div class="form-grid-2" style="font-size:0.88rem;margin-bottom:1rem;">
          <div>
            <strong>Guest:</strong> ${escapeHtml(res.guest_first_name)} ${escapeHtml(res.guest_last_name)} (${escapeHtml(res.guest_email)})<br/>
            <strong>Check-In:</strong> ${escapeHtml(res.check_in)} (15:00) • <strong>Check-Out:</strong> ${escapeHtml(res.check_out)} (12:00)
          </div>
          <div>
            <strong>Total Contracted:</strong> $${Number(res.total_amount).toFixed(2)} USD<br/>
            <strong>Amount Paid:</strong> $${Number(res.amount_paid).toFixed(2)} USD
            ${res.refunded_amount > 0 ? ` • <strong style="color:var(--emerald-ok);">Refunded: $${Number(res.refunded_amount).toFixed(2)} USD</strong>` : ''}
          </div>
        </div>

        <div style="margin-bottom:1rem;">
          <strong style="font-size:0.82rem;text-transform:uppercase;color:var(--text-muted);">Reserved Physical Rooms:</strong>
          <ul style="padding-left:1.2rem;font-size:0.88rem;margin-top:0.25rem;">
            ${(res.rooms || []).map((r) => `<li><strong>Room #${escapeHtml(r.room_number)}</strong> — ${escapeHtml(r.room_name)} (${escapeHtml(r.category_name)}) • $${Number(r.room_total).toFixed(2)}</li>`).join('')}
          </ul>
        </div>

        ${res.status === 'confirmed' ? `
          <div style="border-top:1px solid var(--border-subtle);padding-top:1rem;margin-bottom:1rem;">
            <strong style="font-size:0.82rem;text-transform:uppercase;color:var(--gold-primary);display:block;margin-bottom:0.5rem;">
              Permitted Stay Modifications (Dates &amp; Concierge Preferences)
            </strong>
            <div class="form-grid-2">
              <form onsubmit="window.AureliaApp.submitModifyReservationDates(event, '${escapeHtml(res.booking_reference)}', '${escapeHtml(verificationEmail || res.guest_email)}')" style="background:var(--bg-ivory);padding:0.85rem;border-radius:6px;">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;margin-bottom:0.5rem;">
                  <div>
                    <label style="font-size:0.72rem;font-weight:700;display:block;">New Check-In</label>
                    <input type="date" id="modCheckInInput" value="${escapeHtml(res.check_in)}" required style="width:100%;padding:0.4rem;" />
                  </div>
                  <div>
                    <label style="font-size:0.72rem;font-weight:700;display:block;">New Check-Out</label>
                    <input type="date" id="modCheckOutInput" value="${escapeHtml(res.check_out)}" required style="width:100%;padding:0.4rem;" />
                  </div>
                </div>
                <button type="submit" class="btn-secondary" style="width:100%;padding:0.45rem;font-size:0.8rem;">
                  Verify Availability &amp; Update Stay Dates
                </button>
              </form>

              <form onsubmit="window.AureliaApp.submitUpdateSpecialRequests(event, '${escapeHtml(res.booking_reference)}', '${escapeHtml(verificationEmail || res.guest_email)}')" style="background:var(--bg-ivory);padding:0.85rem;border-radius:6px;">
                <label style="font-size:0.72rem;font-weight:700;display:block;margin-bottom:0.25rem;">Arrival &amp; Concierge Requests</label>
                <input type="text" id="modRequestsInput" value="${escapeHtml(res.special_requests || '')}" placeholder="Dietary notes, arrival time, pillow preference..." style="width:100%;padding:0.45rem;margin-bottom:0.5rem;" />
                <button type="submit" class="btn-secondary" style="width:100%;padding:0.45rem;font-size:0.8rem;">
                  Save Concierge Preferences
                </button>
              </form>
            </div>
          </div>
        ` : ''}

        <!-- Digital Pre-Arrival Butler Dossier & QR Key Pass -->
        ${res.status !== 'cancelled' ? `
          <div style="border-top:1px solid var(--border-subtle);padding-top:1rem;margin-bottom:1rem;">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.65rem;">
              <strong style="font-size:0.84rem;text-transform:uppercase;color:var(--gold-primary);">
                🔑 Digital Pre-Arrival Butler Dossier &amp; Mobile Key Pass
              </strong>
              <span class="staging-badge" style="background:var(--bg-obsidian);color:#86efac;">
                Digital Key: ${escapeHtml(res.preArrivalDossier?.digital_key_code || '')}
              </span>
            </div>
            <form onsubmit="window.AureliaApp.submitPreArrivalDossier(event, '${escapeHtml(res.booking_reference)}', '${escapeHtml(verificationEmail || res.guest_email)}')" style="background:var(--bg-ivory);padding:1rem;border-radius:8px;">
              <div class="search-grid">
                <div class="search-field">
                  <label>8-Option Bespoke Pillow Menu</label>
                  <select id="dosPillowInput">
                    ${[
                      'Quagliotti Goose Down (Medium-Plush)',
                      'Ergonomic Contour Memory Foam',
                      'Organic Swiss Buckwheat Hull',
                      'Alpine Lavender & Chamomile Infused',
                      'Hypoallergenic Micro-Silk Sanctuary',
                      'Loro Piana Cashmere Neck Roll',
                      'Full-Body Maternity / Side-Sleeper Bolster',
                      'Firm Orthopedic Cervical Support'
                    ].map((opt) => `<option value="${escapeHtml(opt)}" ${res.preArrivalDossier?.pillow_preference === opt ? 'selected' : ''}>${escapeHtml(opt)}</option>`).join('')}
                  </select>
                </div>
                <div class="search-field">
                  <label>Suite Climate (°C)</label>
                  <input type="number" step="0.5" min="17" max="26" id="dosTempInput" value="${res.preArrivalDossier?.suite_temperature_c || 21.0}" />
                </div>
                <div class="search-field">
                  <label>Turndown Aromatherapy</label>
                  <select id="dosScentInput">
                    ${[
                      'Grasse Jasmine & White Neroli',
                      'Swiss Stone Pine & Atlas Cedar',
                      'Calming Roman Chamomile & Vetiver',
                      'Pure Unscented / Fragrance-Free'
                    ].map((opt) => `<option value="${escapeHtml(opt)}" ${res.preArrivalDossier?.turndown_scent === opt ? 'selected' : ''}>${escapeHtml(opt)}</option>`).join('')}
                  </select>
                </div>
                <div class="search-field">
                  <label>Arrival Logistics</label>
                  <select id="dosTransportInput">
                    ${[
                      'Rolls-Royce Chauffeur Pickup',
                      'Private Jet FBO Meet-and-Greet',
                      'Rooftop Helipad Arrival',
                      'Private Yacht Marina Pier',
                      'Personal Vehicle / Palace Valet'
                    ].map((opt) => `<option value="${escapeHtml(opt)}" ${res.preArrivalDossier?.arrival_transport_mode === opt ? 'selected' : ''}>${escapeHtml(opt)}</option>`).join('')}
                  </select>
                </div>
                <div class="search-field">
                  <label>Flight / Tail # &amp; ETA</label>
                  <input type="text" id="dosFlightInput" value="${escapeHtml(res.preArrivalDossier?.flight_or_tail_number || '')}" placeholder="e.g. LX-402 • 15:30" />
                </div>
                <div class="search-field">
                  <label>Dietary / Allergies</label>
                  <input type="text" id="dosDietInput" value="${escapeHtml(res.preArrivalDossier?.dietary_allergies || 'None')}" />
                </div>
                <div class="search-field">
                  <button type="submit" class="btn-primary" style="width:100%;">Save Butler Dossier</button>
                </div>
              </div>
            </form>
          </div>
        ` : ''}

        <!-- In-Stay Incidental Folio Ledger & FolioChargeVoidUI -->
        ${res.folioCharges && res.folioCharges.length > 0 ? `
          <div style="border-top:1px solid var(--border-subtle);padding-top:0.85rem;margin-bottom:1rem;">
            <strong style="font-size:0.82rem;text-transform:uppercase;color:var(--text-muted);">In-Stay Incidental Folio Charges ($${Number(res.incidentalTotal).toFixed(2)} USD):</strong>
            <ul style="padding-left:1.2rem;font-size:0.84rem;margin-top:0.35rem;">
              ${res.folioCharges.map((fc) => `
                <li style="margin-bottom:0.25rem;">
                  <strong>${escapeHtml(fc.category)}</strong>: ${escapeHtml(fc.description)} (${fc.quantity} × $${Number(fc.unit_price).toFixed(2)}) = <strong>$${Number(fc.total_amount).toFixed(2)} USD</strong>
                  ${state.currentUser && ['finance', 'manager', 'admin'].includes(state.currentUser.role) ? `
                    <button type="button" class="nearby-date-btn" style="margin-left:0.5rem;" onclick="window.AureliaApp.voidFolioChargeUI('${escapeHtml(res.booking_reference)}', ${fc.id}, '${escapeHtml(verificationEmail || res.guest_email)}')">
                      Void Charge
                    </button>
                  ` : ''}
                </li>
              `).join('')}
            </ul>
          </div>
        ` : ''}

        <!-- DiningAndSpaSlotBookingModule UI -->
        ${res.status !== 'cancelled' ? `
          <div style="border-top:1px solid var(--border-subtle);padding-top:1rem;margin-bottom:1rem;">
            <strong style="font-size:0.84rem;text-transform:uppercase;color:var(--gold-primary);display:block;margin-bottom:0.5rem;">
              🍽️ Michelin Dining &amp; Thermal Sanctuary Time-Slot Reservations
            </strong>
            ${res.facilityBookings && res.facilityBookings.length > 0 ? `
              <div style="margin-bottom:0.75rem;">
                ${res.facilityBookings.map((fb) => `
                  <div style="display:flex;justify-content:space-between;align-items:center;background:#f0fdf4;border:1px solid #bbf7d0;padding:0.5rem 0.75rem;border-radius:6px;margin-bottom:0.35rem;font-size:0.82rem;">
                    <span>
                      <strong>${escapeHtml(fb.facility_name)}</strong> — ${escapeHtml(fb.treatment_or_menu)}
                      (${escapeHtml(fb.reservation_date)} @ <strong>${escapeHtml(fb.slot_time)}</strong>, ${fb.guests_count} guests, $${Number(fb.price).toFixed(2)})
                    </span>
                    <button type="button" class="nearby-date-btn" onclick="window.AureliaApp.cancelFacilitySlotUI('${escapeHtml(res.booking_reference)}', ${fb.id}, '${escapeHtml(verificationEmail || res.guest_email)}')">
                      Cancel Slot
                    </button>
                  </div>
                `).join('')}
              </div>
            ` : ''}
            <form onsubmit="window.AureliaApp.submitFacilitySlotBooking(event, '${escapeHtml(res.booking_reference)}', '${escapeHtml(verificationEmail || res.guest_email)}')" class="search-grid" style="background:var(--bg-ivory);padding:0.85rem;border-radius:6px;">
              <div class="search-field">
                <label>Sanctuary Venue</label>
                <select id="facTypeInput">
                  <option value="michelin_dining">Le Jardin d’Or (3-Michelin-Star)</option>
                  <option value="thermal_spa">Travertine Thermal Spa</option>
                  <option value="private_cinema">Aurélia Private Velvet Cinema</option>
                  <option value="yacht_charter">Riva Yacht Marina Pier</option>
                </select>
              </div>
              <div class="search-field">
                <label>Date</label>
                <input type="date" id="facDateInput" value="${escapeHtml(res.check_in)}" required />
              </div>
              <div class="search-field">
                <label>Time Slot</label>
                <select id="facTimeInput">
                  <option value="11:00">11:00 Morning</option>
                  <option value="14:30">14:30 Afternoon</option>
                  <option value="17:00">17:00 Twilight</option>
                  <option value="19:30" selected>19:30 First Seating</option>
                  <option value="21:00">21:00 Gala Seating</option>
                </select>
              </div>
              <div class="search-field">
                <label>Menu / Treatment</label>
                <input type="text" id="facMenuInput" value="Seven-Course Chef Tasting Table" required />
              </div>
              <div class="search-field">
                <label>Folio Charge ($)</label>
                <input type="number" step="1" id="facPriceInput" value="195" min="0" required />
              </div>
              <div class="search-field">
                <button type="submit" class="btn-primary" style="width:100%;">Reserve Slot</button>
              </div>
            </form>
          </div>
        ` : ''}

        <!-- Verified Guest Review Form -->
        ${res.status !== 'cancelled' ? `
          <div style="border-top:1px solid var(--border-subtle);padding-top:0.85rem;margin-bottom:1rem;">
            <strong style="font-size:0.82rem;text-transform:uppercase;color:var(--gold-primary);display:block;margin-bottom:0.45rem;">
              ★ Verified Guest Stay Review ${res.guestReview ? '(Submitted — You may update below)' : ''}
            </strong>
            <form onsubmit="window.AureliaApp.submitVerifiedStayReview(event, '${escapeHtml(res.booking_reference)}', '${escapeHtml(verificationEmail || res.guest_email)}')" class="search-grid" style="background:var(--bg-ivory);padding:0.85rem;border-radius:6px;">
              <div class="search-field">
                <label>Rating</label>
                <select id="revRatingInput">
                  <option value="5" ${!res.guestReview || res.guestReview.rating === 5 ? 'selected' : ''}>★★★★★ (5/5 Exceptional)</option>
                  <option value="4" ${res.guestReview?.rating === 4 ? 'selected' : ''}>★★★★☆ (4/5 Distinguished)</option>
                  <option value="3" ${res.guestReview?.rating === 3 ? 'selected' : ''}>★★★☆☆ (3/5 Satisfactory)</option>
                </select>
              </div>
              <div class="search-field">
                <label>Review Headline</label>
                <input type="text" id="revTitleInput" value="${escapeHtml(res.guestReview?.title || 'Unforgettable Five-Star Sanctuary')}" required />
              </div>
              <div class="search-field" style="grid-column:span 2;">
                <label>Your Experience</label>
                <input type="text" id="revCommentInput" value="${escapeHtml(res.guestReview?.comment || 'Impeccable butler service, serene architecture, and effortless reservation experience.')}" required />
              </div>
              <div class="search-field">
                <button type="submit" class="btn-secondary" style="width:100%;">Publish Verified Review</button>
              </div>
            </form>
          </div>
        ` : ''}

        ${res.notifications && res.notifications.length > 0 ? `
          <div style="border-top:1px solid var(--border-subtle);padding-top:0.85rem;">
            <strong style="font-size:0.8rem;text-transform:uppercase;color:var(--text-muted);">Dispatched Notifications &amp; Receipts Log:</strong>
            ${res.notifications.map((n) => `
              <div style="background:var(--bg-ivory);padding:0.65rem;border-radius:6px;margin-top:0.45rem;font-size:0.8rem;">
                <strong>${escapeHtml(n.subject)}</strong> <span style="color:var(--text-muted);">(${escapeHtml(n.created_at)} UTC)</span>
                <pre style="white-space:pre-wrap;font-family:var(--font-sans);margin-top:0.3rem;color:#334155;">${escapeHtml(n.body)}</pre>
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }

  async function promptCancelReservation(bookingReference, email) {
    try {
      const res = await apiFetch(`/api/bookings/${encodeURIComponent(bookingReference)}/cancel`, {
        method: 'POST',
        body: JSON.stringify({
          email,
          reason: 'Guest self-service cancellation via online portal'
        })
      });
      const container = document.getElementById('lookupResultContainer');
      if (container && !document.getElementById('view-lookup').classList.contains('hidden')) {
        renderLookupReservationCard(res.reservation, container, email);
      }
      if (!document.getElementById('view-portal').classList.contains('hidden')) {
        await renderGuestPortal();
      }
      if (!document.getElementById('view-admin').classList.contains('hidden')) {
        await loadAdminTab(state.currentAdminTab);
      }
      await performAvailabilitySearch();
    } catch (err) {
      alert(err.message);
    }
  }

  async function submitModifyReservationDates(e, bookingReference, email) {
    e.preventDefault();
    try {
      const newCheckIn = document.getElementById('modCheckInInput').value;
      const newCheckOut = document.getElementById('modCheckOutInput').value;
      const res = await apiFetch(`/api/bookings/${encodeURIComponent(bookingReference)}/modify-dates`, {
        method: 'POST',
        body: JSON.stringify({
          email,
          newCheckIn,
          newCheckOut
        })
      });
      const container = document.getElementById('lookupResultContainer');
      if (container) {
        renderLookupReservationCard(res.reservation, container, email);
      }
      await performAvailabilitySearch();
    } catch (err) {
      alert(err.message);
    }
  }

  async function submitUpdateSpecialRequests(e, bookingReference, email) {
    e.preventDefault();
    try {
      const specialRequests = document.getElementById('modRequestsInput').value;
      const res = await apiFetch(`/api/bookings/${encodeURIComponent(bookingReference)}/requests`, {
        method: 'PATCH',
        body: JSON.stringify({
          email,
          specialRequests
        })
      });
      const container = document.getElementById('lookupResultContainer');
      if (container) {
        renderLookupReservationCard(res.reservation, container, email);
      }
    } catch (err) {
      alert(err.message);
    }
  }

  async function submitPreArrivalDossier(e, bookingReference, email) {
    e.preventDefault();
    try {
      const res = await apiFetch(`/api/bookings/${encodeURIComponent(bookingReference)}/dossier`, {
        method: 'PUT',
        body: JSON.stringify({
          email,
          pillowPreference: document.getElementById('dosPillowInput').value,
          suiteTemperatureC: Number(document.getElementById('dosTempInput').value),
          turndownScent: document.getElementById('dosScentInput').value,
          arrivalTransportMode: document.getElementById('dosTransportInput').value,
          flightOrTailNumber: document.getElementById('dosFlightInput').value,
          dietaryAllergies: document.getElementById('dosDietInput').value
        })
      });
      const container = document.getElementById('lookupResultContainer');
      if (container) {
        renderLookupReservationCard(res.reservation, container, email);
      }
    } catch (err) {
      alert(err.message);
    }
  }

  async function submitVerifiedStayReview(e, bookingReference, email) {
    e.preventDefault();
    try {
      const res = await apiFetch(`/api/bookings/${encodeURIComponent(bookingReference)}/review`, {
        method: 'POST',
        body: JSON.stringify({
          email,
          rating: Number(document.getElementById('revRatingInput').value),
          title: document.getElementById('revTitleInput').value,
          comment: document.getElementById('revCommentInput').value
        })
      });
      const container = document.getElementById('lookupResultContainer');
      if (container) {
        renderLookupReservationCard(res.reservation, container, email);
      }
    } catch (err) {
      alert(err.message);
    }
  }

  async function submitFacilitySlotBooking(e, bookingReference, email) {
    e.preventDefault();
    try {
      const res = await apiFetch(`/api/bookings/${encodeURIComponent(bookingReference)}/facilities`, {
        method: 'POST',
        body: JSON.stringify({
          email,
          facilityType: document.getElementById('facTypeInput').value,
          reservationDate: document.getElementById('facDateInput').value,
          slotTime: document.getElementById('facTimeInput').value,
          treatmentOrMenu: document.getElementById('facMenuInput').value,
          price: Number(document.getElementById('facPriceInput').value || 0)
        })
      });
      const container = document.getElementById('lookupResultContainer');
      if (container) {
        renderLookupReservationCard(res.reservation, container, email);
      }
    } catch (err) {
      alert(err.message);
    }
  }

  async function cancelFacilitySlotUI(bookingReference, slotId, email) {
    try {
      const res = await apiFetch(`/api/bookings/${encodeURIComponent(bookingReference)}/facilities/${slotId}?email=${encodeURIComponent(email)}`, {
        method: 'DELETE'
      });
      const container = document.getElementById('lookupResultContainer');
      if (container) {
        renderLookupReservationCard(res.reservation, container, email);
      }
    } catch (err) {
      alert(err.message);
    }
  }

  async function voidFolioChargeUI(bookingReference, chargeId, email) {
    try {
      const res = await apiFetch(`/api/admin/reservations/${encodeURIComponent(bookingReference)}/folio/${chargeId}`, {
        method: 'DELETE'
      });
      const container = document.getElementById('lookupResultContainer');
      if (container && !document.getElementById('view-lookup').classList.contains('hidden')) {
        renderLookupReservationCard(res.reservation, container, email);
      }
      if (!document.getElementById('view-admin').classList.contains('hidden')) {
        await loadAdminTab('reservations');
      }
    } catch (err) {
      alert(err.message);
    }
  }

  // -------------------------------------------------------------------------
  // View 3: Guest Privé Account Portal
  // -------------------------------------------------------------------------

  async function handleLoginSubmit(e) {
    e.preventDefault();
    try {
      const data = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: document.getElementById('loginEmail').value,
          password: document.getElementById('loginPassword').value
        })
      });
      state.authToken = data.token;
      state.currentUser = data.user;
      localStorage.setItem('aurelia_auth_token', data.token);
      await renderGuestPortal();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleRegisterSubmit(e) {
    e.preventDefault();
    try {
      const data = await apiFetch('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          firstName: document.getElementById('regFirstName').value,
          lastName: document.getElementById('regLastName').value,
          email: document.getElementById('regEmail').value,
          phone: document.getElementById('regPhone').value,
          country: document.getElementById('regCountry').value,
          password: document.getElementById('regPassword').value
        })
      });
      state.authToken = data.token;
      state.currentUser = data.user;
      localStorage.setItem('aurelia_auth_token', data.token);
      await renderGuestPortal();
    } catch (err) {
      alert(err.message);
    }
  }

  function logout() {
    state.authToken = '';
    state.currentUser = null;
    localStorage.removeItem('aurelia_auth_token');
    renderGuestPortal();
  }

  async function quickGuestLogin(email, password) {
    try {
      const data = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });
      state.authToken = data.token;
      state.currentUser = data.user;
      localStorage.setItem('aurelia_auth_token', data.token);
      await renderGuestPortal();
    } catch (err) {
      alert(err.message);
    }
  }

  let currentGuestTab = 'overview';
  let cachedGuestDashboard = null;

  async function switchGuestTab(tabName, btnEl = null) {
    currentGuestTab = tabName;
    if (btnEl) {
      document.querySelectorAll('.guest-tab-btn').forEach((b) => b.classList.remove('active'));
      btnEl.classList.add('active');
    }
    await renderGuestPortal();
  }

  async function renderGuestPortal() {
    const authBox = document.getElementById('portalGuestAuthBox');
    const dashBox = document.getElementById('portalAuthenticatedDashboard');
    const tabContainer = document.getElementById('guestPortalTabContent');
    if (!authBox || !dashBox) return;

    if (!state.currentUser) {
      authBox.classList.remove('hidden');
      dashBox.classList.add('hidden');
      return;
    }

    authBox.classList.add('hidden');
    dashBox.classList.remove('hidden');

    try {
      const dash = await apiFetch('/api/guest/dashboard');
      cachedGuestDashboard = dash;
      if (dash.user) {
        state.currentUser = dash.user;
      }
      const u = state.currentUser;
      const m = dash.metrics;

      document.getElementById('guestLoyaltyBadge').textContent = m.loyaltyTier;
      document.getElementById('guestWelcomeName').textContent = `${u.first_name} ${u.last_name} (${u.email})`;
      document.getElementById('guestLoyaltyPoints').textContent = `${m.loyaltyPoints.toLocaleString()} Privilege Points ($${m.redeemableCreditUsd.toLocaleString()} Instant Checkout Credit Available) • Role: ${u.role.toUpperCase()}`;

      if (!tabContainer) return;

      if (currentGuestTab === 'overview') {
        renderGuestOverviewTab(tabContainer, dash);
      } else if (currentGuestTab === 'bookings') {
        renderGuestBookingsTab(tabContainer, dash);
      } else if (currentGuestTab === 'messages') {
        await renderGuestMessagesTab(tabContainer, dash);
      } else if (currentGuestTab === 'concierge') {
        renderGuestConciergeTab(tabContainer, dash);
      } else if (currentGuestTab === 'waitlist') {
        renderGuestWaitlistTab(tabContainer, dash);
      } else if (currentGuestTab === 'profile') {
        renderGuestProfileTab(tabContainer, dash);
      }
    } catch (err) {
      console.error('Guest portal error:', err);
    }
  }

  function renderGuestOverviewTab(container, dash) {
    const m = dash.metrics;
    const progressPct = m.loyaltyPoints >= 15000 ? 100 : Math.min(100, Math.round((m.loyaltyPoints / 15000) * 100));

    container.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">Total Palace Stays</div>
          <div class="kpi-value">${m.totalStays}</div>
          <div style="font-size:0.75rem;color:#64748b;">${m.upcomingStaysCount} upcoming • ${m.totalNights} total room-nights</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Lifetime Sanctuary Spend</div>
          <div class="kpi-value">$${m.lifetimeSpendUsd.toLocaleString()}</div>
          <div style="font-size:0.75rem;color:#64748b;">Includes Suites, Michelin Dining &amp; Spa Folios</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Loyalty Privilege Points</div>
          <div class="kpi-value" style="color:var(--gold-primary);">${m.loyaltyPoints.toLocaleString()} pts</div>
          <div style="font-size:0.75rem;color:#64748b;">Tier: <strong>${escapeHtml(m.loyaltyTier)}</strong></div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Redeemable Checkout Credit</div>
          <div class="kpi-value" style="color:var(--emerald-ok);">$${m.redeemableCreditUsd.toLocaleString()}</div>
          <div style="font-size:0.75rem;color:#64748b;">10 points = $1.00 USD instant suite discount</div>
        </div>
      </div>

      <div class="checkout-columns" style="margin-top:1.5rem;">
        <div class="kpi-card">
          <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin-bottom:0.5rem;">Aurélia Privé Tier Status &amp; Progression</h4>
          <p style="font-size:0.84rem;color:#475569;margin-bottom:0.75rem;">
            Current Tier: <strong>${escapeHtml(m.loyaltyTier)}</strong> •
            ${m.pointsToNextTier > 0 ? `${m.pointsToNextTier.toLocaleString()} points until <strong>${escapeHtml(m.nextTier)}</strong>` : 'Highest Imperial Black Tier Achieved'}
          </p>
          <div style="background:#e2e8f0;height:12px;border-radius:999px;overflow:hidden;margin-bottom:1rem;">
            <div style="width:${progressPct}%;height:100%;background:linear-gradient(90deg, #b89146, #d4af63);"></div>
          </div>
          <ul style="padding-left:1.2rem;font-size:0.83rem;color:#334155;line-height:1.7;">
            <li><strong>Aurélia Privé (1,000+ pts):</strong> Complimentary Thermal Sanctuary access, bespoke pillow &amp; scent menu.</li>
            <li><strong>Gold Sanctuary (5,000+ pts):</strong> Guaranteed 16:00 late check-out, priority Michelin table seating at <em>Le Jardin d’Or</em>.</li>
            <li><strong>Imperial Black (15,000+ pts):</strong> Complimentary Rolls-Royce airport transfer, dedicated 24/7 Head Butler &amp; suite upgrades.</li>
          </ul>
        </div>

        <div class="kpi-card">
          <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin-bottom:0.65rem;">Quick Guest Actions &amp; Recent Stays</h4>
          <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:1rem;">
            <button type="button" class="btn-primary" onclick="window.AureliaApp.switchView('home')">Explore Suites &amp; Book Stay</button>
            <button type="button" class="btn-secondary" onclick="window.AureliaApp.switchGuestTab('concierge')">Request VIP Concierge</button>
            <button type="button" class="btn-secondary" onclick="window.AureliaApp.switchGuestTab('bookings')">Manage Reservations (${dash.reservations.length})</button>
          </div>
          ${dash.reservations.length === 0 ? `<p style="font-size:0.84rem;color:#64748b;">No reservations recorded yet.</p>` : dash.reservations.slice(0, 2).map((r) => `
            <div style="border-top:1px solid #e2e8f0;padding-top:0.65rem;margin-top:0.65rem;font-size:0.83rem;display:flex;justify-content:space-between;align-items:center;">
              <div>
                <strong><code>${escapeHtml(r.booking_reference)}</code></strong> — ${(r.rooms || []).map((rm) => `#${escapeHtml(rm.room_number)} ${escapeHtml(rm.room_name)}`).join(', ')}<br/>
                <span style="color:#64748b;">${escapeHtml(r.check_in)} &rarr; ${escapeHtml(r.check_out)} • $${Number(r.grandFolioTotal || r.total_amount).toFixed(2)} USD</span>
              </div>
              <button type="button" class="nearby-date-btn" onclick="window.AureliaApp.openBookingInLookup('${escapeHtml(r.booking_reference)}', '${escapeHtml(r.guest_email)}')">Manage Dossier</button>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderGuestBookingsTab(container, dash) {
    if (!dash.reservations || dash.reservations.length === 0) {
      container.innerHTML = `
        <div class="kpi-card" style="text-align:center;padding:2.5rem;">
          <h4 style="font-family:var(--font-serif);font-size:1.4rem;margin-bottom:0.5rem;">No Reservations Yet</h4>
          <p style="font-size:0.88rem;color:#64748b;margin-bottom:1rem;">Reserve any suite to unlock your Digital Suite Key, Pre-Arrival Butler Dossier, and Michelin Dining time-slot reservations.</p>
          <button type="button" class="btn-primary" onclick="window.AureliaApp.switchView('home')">Browse Suites &amp; Availability</button>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <h4 style="font-family:var(--font-serif);font-size:1.4rem;margin-bottom:1rem;">Your Upcoming &amp; Historical Reservations (${dash.reservations.length})</h4>
      ${dash.reservations.map((r) => `
        <div class="kpi-card" style="margin-bottom:1.1rem;">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.75rem;border-bottom:1px solid #e2e8f0;padding-bottom:0.75rem;margin-bottom:0.75rem;">
            <div>
              <span class="status-pill ${escapeHtml(r.status)}">${escapeHtml(r.status)}</span>
              <span class="status-pill ${escapeHtml(r.payment_status)}" style="margin-left:0.35rem;">${escapeHtml(r.payment_status)}</span>
              <strong style="font-size:1.1rem;margin-left:0.5rem;"><code>${escapeHtml(r.booking_reference)}</code></strong>
              <span style="font-size:0.82rem;color:#64748b;margin-left:0.5rem;">${escapeHtml(r.check_in)} &rarr; ${escapeHtml(r.check_out)} (${r.nights} night(s))</span>
            </div>
            <div style="display:flex;gap:0.45rem;flex-wrap:wrap;">
              <button type="button" class="btn-primary" style="padding:0.4rem 0.85rem;font-size:0.78rem;" onclick="window.AureliaApp.openBookingInLookup('${escapeHtml(r.booking_reference)}', '${escapeHtml(r.guest_email)}')">
                🔑 Butler Dossier, Dining Slots &amp; Date Changes
              </button>
              <a href="/api/bookings/${encodeURIComponent(r.booking_reference)}/invoice?format=html" target="_blank" class="btn-secondary" style="padding:0.4rem 0.85rem;font-size:0.78rem;text-decoration:none;">
                🖨️ Tax &amp; Folio Invoice
              </a>
              ${r.status !== 'cancelled' && r.status !== 'checked_out' ? `
                <button type="button" class="btn-danger" style="padding:0.4rem 0.85rem;font-size:0.78rem;" onclick="window.AureliaApp.promptCancelReservation('${escapeHtml(r.booking_reference)}', '${escapeHtml(r.guest_email)}')">
                  Cancel Booking
                </button>
              ` : ''}
            </div>
          </div>

          <div class="form-grid-3" style="font-size:0.83rem;">
            <div>
              <strong>Reserved Suite(s):</strong><br/>
              ${(r.rooms || []).map((rm) => `#${escapeHtml(rm.room_number)} ${escapeHtml(rm.room_name)}`).join(', ')}
            </div>
            <div>
              <strong>Digital Key &amp; Butler Preferences:</strong><br/>
              Key Pass: <code>${escapeHtml(r.preArrivalDossier?.digital_key_code || 'KEY-' + r.booking_reference)}</code><br/>
              Pillow: ${escapeHtml(r.preArrivalDossier?.pillow_preference || 'Standard')} (${r.preArrivalDossier?.suite_temperature_c || 21}°C)
            </div>
            <div>
              <strong>Financial Folio Summary:</strong><br/>
              Stay Total: <strong>$${Number(r.total_amount).toFixed(2)} USD</strong>
              ${r.incidentalTotal > 0 ? ` • In-Stay Folio: +$${Number(r.incidentalTotal).toFixed(2)}` : ''}<br/>
              Amount Paid: $${Number(r.amount_paid).toFixed(2)} USD
              ${r.loyalty_points_redeemed > 0 ? ` • Redeemed: ${r.loyalty_points_redeemed} pts (-$${Number(r.loyalty_discount_amount).toFixed(2)})` : ''}
            </div>
          </div>
        </div>
      `).join('')}
    `;
  }

  function renderGuestConciergeTab(container, dash) {
    const requests = dash.conciergeRequests || [];
    container.innerHTML = `
      <div class="checkout-columns">
        <div class="kpi-card">
          <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin-bottom:0.5rem;">Direct VIP Concierge &amp; Butler Request</h4>
          <p style="font-size:0.82rem;color:#64748b;margin-bottom:0.85rem;">
            Submit bespoke arrangements directly to our Head Concierge Desk — Rolls-Royce airport transfers, private helicopter arrival, sommelier cellar tastings, or in-suite amenities.
          </p>
          <form onsubmit="window.AureliaApp.handleCreateConciergeRequestSubmit(event)">
            <div class="form-grid-2">
              <div class="form-group">
                <label>Service Department</label>
                <select id="concCategory">
                  <option value="Chauffeur & Aviation">Rolls-Royce Chauffeur &amp; Helipad</option>
                  <option value="Michelin Dining & Sommelier">Le Jardin d’Or &amp; Sommelier Cellar</option>
                  <option value="Thermal Spa & Wellness">Thermal Sanctuary &amp; Private Hammam</option>
                  <option value="Housekeeping & Butler">In-Suite Butler &amp; Housekeeping</option>
                  <option value="Yacht & Lake Excursions">Private Riva Yacht Charter</option>
                </select>
              </div>
              <div class="form-group">
                <label>Link to Reservation (Optional)</label>
                <select id="concBookingRef">
                  <option value="">General Membership Request</option>
                  ${(dash.reservations || []).map((r) => `<option value="${escapeHtml(r.booking_reference)}">${escapeHtml(r.booking_reference)} (${escapeHtml(r.check_in)})</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="form-grid-2">
              <div class="form-group">
                <label>Priority Level</label>
                <select id="concPriority">
                  <option value="normal">Standard Privilege</option>
                  <option value="vip_urgent">VIP Immediate Attention</option>
                </select>
              </div>
              <div class="form-group">
                <label>Preferred Date / Time</label>
                <input type="text" id="concPrefTime" value="Upon Arrival at 15:30" />
              </div>
            </div>
            <div class="form-group">
              <label>Request Subject *</label>
              <input type="text" id="concSubject" placeholder="e.g. Rolls-Royce Phantom Pickup at Geneva Airport VIP Wing" required />
            </div>
            <div class="form-group">
              <label>Detailed Instructions for Head Concierge *</label>
              <textarea id="concDetails" rows="3" placeholder="Flight number, number of passengers, champagne preference..." required></textarea>
            </div>
            <button type="submit" class="btn-primary" style="width:100%;">Dispatch Request to Palace Concierge Desk</button>
          </form>
        </div>

        <div>
          <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin-bottom:0.75rem;">Your Active &amp; Past Concierge Requests (${requests.length})</h4>
          ${requests.length === 0 ? `<div class="kpi-card"><p style="font-size:0.84rem;color:#64748b;">You have not submitted any concierge service requests yet.</p></div>` : requests.map((cr) => `
            <div class="kpi-card" style="margin-bottom:0.85rem;font-size:0.83rem;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.35rem;">
                <strong><code>${escapeHtml(cr.request_reference)}</code> — ${escapeHtml(cr.subject)}</strong>
                <span class="status-pill ${cr.status === 'fulfilled' ? 'confirmed' : cr.status === 'cancelled' ? 'cancelled' : 'checked_in'}">${escapeHtml(cr.status)}</span>
              </div>
              <div style="color:#64748b;font-size:0.76rem;margin-bottom:0.35rem;">
                ${escapeHtml(cr.category)} • Priority: <strong>${escapeHtml(cr.priority)}</strong> ${cr.booking_reference ? `• Booking: <code>${escapeHtml(cr.booking_reference)}</code>` : ''}
              </div>
              <p style="color:#334155;margin-bottom:0.4rem;">${escapeHtml(cr.details)}</p>
              ${cr.staff_notes ? `
                <div style="background:#f0fdf4;border:1px solid #bbf7d0;padding:0.5rem 0.75rem;border-radius:6px;color:#166534;font-size:0.79rem;">
                  <strong>Concierge Desk Response (${escapeHtml(cr.handled_by || 'Head Concierge')}):</strong> ${escapeHtml(cr.staff_notes)}
                </div>
              ` : ''}
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderGuestWaitlistTab(container, dash) {
    const list = dash.waitlist || [];
    container.innerHTML = `
      <div class="kpi-card">
        <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin-bottom:0.5rem;">Your Priority Room Waitlist &amp; Automated Release Alerts (${list.length})</h4>
        <p style="font-size:0.83rem;color:#64748b;margin-bottom:1rem;">
          Whenever a suite you waitlisted is released by a cancellation, our engine immediately transitions your alert status to <strong>notified</strong> and dispatches an instant notification.
        </p>
        <div class="data-table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>Waitlist Ref</th>
                <th>Room / Suite</th>
                <th>Requested Stay</th>
                <th>Alert Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${list.length === 0 ? '<tr><td colspan="5">You have no active priority waitlist entries.</td></tr>' : list.map((w) => `
                <tr>
                  <td><code>${escapeHtml(w.waitlist_reference)}</code></td>
                  <td>${w.room_number ? `<strong>#${escapeHtml(w.room_number)} ${escapeHtml(w.room_name || '')}</strong>` : escapeHtml(w.category_name || 'Any Suite')}</td>
                  <td>${escapeHtml(w.check_in)} &rarr; ${escapeHtml(w.check_out)}</td>
                  <td><span class="status-pill ${w.status === 'notified' ? 'confirmed' : w.status === 'cancelled' ? 'cancelled' : 'checked_in'}">${escapeHtml(w.status)}</span></td>
                  <td>
                    ${w.status === 'waiting' ? `<button type="button" class="nearby-date-btn" onclick="window.AureliaApp.cancelGuestWaitlistEntry(${w.id})">Remove</button>` : ''}
                    ${w.status === 'notified' ? `<button type="button" class="nearby-date-btn" style="border-color:var(--emerald-ok);color:var(--emerald-ok);" onclick="window.AureliaApp.applySuggestedDates('${escapeHtml(w.check_in)}', '${escapeHtml(w.check_out)}'); window.AureliaApp.switchView('home');">Book Now</button>` : ''}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  let activeGuestThreadId = null;

  async function renderGuestMessagesTab(container, dash) {
    const threads = dash.messageThreads || [];
    if (!activeGuestThreadId && threads.length > 0) {
      activeGuestThreadId = threads[0].id;
    }

    let activeThreadDetail = null;
    if (activeGuestThreadId) {
      try {
        const detailRes = await apiFetch(`/api/guest/messages/${activeGuestThreadId}`);
        activeThreadDetail = detailRes.thread;
      } catch (_) {
        activeThreadDetail = null;
      }
    }

    container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;background:#0b132b;color:#f8fafc;padding:0.75rem 1.1rem;border-radius:6px;margin-bottom:1.25rem;flex-wrap:wrap;gap:0.75rem;border-left:4px solid #c5a059;">
        <div>
          <strong style="font-size:0.9rem;color:var(--gold-bright);">💬 Guest Direct Messaging Inbox</strong>
          <span style="font-size:0.8rem;color:#cbd5e1;margin-left:0.5rem;">Signed in as User: <strong>${escapeHtml(state.currentUser.first_name)} ${escapeHtml(state.currentUser.last_name)}</strong> (${escapeHtml(state.currentUser.email)})</span>
        </div>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
          <button type="button" class="staging-banner-action" onclick="window.AureliaApp.markAllGuestMessagesRead()">✓ Mark All Read</button>
          <button type="button" class="staging-banner-action" onclick="window.AureliaApp.switchToAdminMessagingInbox()">Switch to Admin Inbox to Reply as Admin &rarr;</button>
        </div>
      </div>

      <div class="checkout-columns" style="align-items:start;">
        <div>
          <!-- Start New Message Thread to Admin / Concierge -->
          <div class="kpi-card" style="margin-bottom:1.25rem;">
            <h4 style="font-family:var(--font-serif);font-size:1.3rem;margin-bottom:0.5rem;">💬 Compose New Message to Hotel Admin &amp; Concierge</h4>
            <p style="font-size:0.8rem;color:#64748b;margin-bottom:0.75rem;">
              Message our Palace Administration, Front Desk, Finance, or Head Concierge directly. Replies appear here in real time.
            </p>
            <form onsubmit="window.AureliaApp.handleGuestStartMessageSubmit(event)">
              <div class="form-grid-2">
                <div class="form-group">
                  <label>Recipient Department</label>
                  <select id="gMsgDept">
                    <option value="Head Concierge & Admin">Head Concierge &amp; Admin</option>
                    <option value="Front Desk & Reservations">Front Desk &amp; Reservations</option>
                    <option value="Finance & Folio Billing">Finance &amp; Folio Billing</option>
                    <option value="Michelin Dining & Sommelier">Le Jardin d’Or (Michelin)</option>
                    <option value="Thermal Spa & Wellness">Thermal Spa Sanctuary</option>
                  </select>
                </div>
                <div class="form-group">
                  <label>Related Booking (Optional)</label>
                  <select id="gMsgBookingRef">
                    <option value="">General Account Inquiry</option>
                    ${(dash.reservations || []).map((r) => `<option value="${escapeHtml(r.booking_reference)}">${escapeHtml(r.booking_reference)} (${escapeHtml(r.check_in)})</option>`).join('')}
                  </select>
                </div>
              </div>
              <div class="form-grid-2">
                <div class="form-group">
                  <label>Subject *</label>
                  <input type="text" id="gMsgSubject" placeholder="e.g. Bespoke Suite Arrangement &amp; Arrival Timing" required />
                </div>
                <div class="form-group">
                  <label>Urgency</label>
                  <select id="gMsgPriority">
                    <option value="normal">Standard Privilege</option>
                    <option value="vip_urgent">VIP Urgent</option>
                  </select>
                </div>
              </div>
              <div class="form-group">
                <label>Message to Admin *</label>
                <textarea id="gMsgBody" rows="3" placeholder="Write your message to Hotel Administration or Concierge..." required></textarea>
              </div>
              <button type="submit" class="btn-primary" style="width:100%;">Send Message to Admin Inbox</button>
            </form>
          </div>

          <!-- Thread List -->
          <div class="kpi-card">
            <h4 style="font-family:var(--font-serif);font-size:1.25rem;margin-bottom:0.65rem;">Your Conversation Threads (${threads.length})</h4>
            ${threads.length === 0 ? `<p style="font-size:0.84rem;color:#64748b;">No conversation threads yet. Send a message above to start chatting with Admin.</p>` : threads.map((t) => `
              <div onclick="window.AureliaApp.selectGuestMessageThread(${t.id})" style="cursor:pointer;padding:0.75rem;border-radius:6px;margin-bottom:0.5rem;border:1px solid ${t.id === activeGuestThreadId ? 'var(--gold-primary)' : '#e2e8f0'};background:${t.id === activeGuestThreadId ? '#fffbeb' : '#ffffff'};">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                  <strong style="font-size:0.86rem;"><code>${escapeHtml(t.thread_reference)}</code> — ${escapeHtml(t.subject)}</strong>
                  ${t.unread_by_guest > 0 ? `<span class="status-pill confirmed">NEW REPLY (${t.unread_by_guest})</span>` : `<span class="status-pill ${t.status === 'resolved' ? 'confirmed' : 'checked_in'}">${escapeHtml(t.status)}</span>`}
                </div>
                <div style="font-size:0.75rem;color:#64748b;margin-top:0.2rem;">
                  ${escapeHtml(t.department)} ${t.booking_reference ? `• Booking: <code>${escapeHtml(t.booking_reference)}</code>` : ''} • ${t.messages_count || 1} msg(s)
                </div>
                <div style="font-size:0.79rem;color:#334155;margin-top:0.25rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  <strong>${escapeHtml(t.last_sender_name || '')}:</strong> ${escapeHtml(t.last_message_preview || '')}
                </div>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- Active Conversation Thread Reader & Reply Box -->
        <div class="kpi-card">
          ${!activeThreadDetail ? `
            <div style="text-align:center;padding:2.5rem;color:#64748b;">
              <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin-bottom:0.4rem;">Select or Start a Conversation</h4>
              <p style="font-size:0.85rem;">Choose any conversation thread on the left or compose a new message to Hotel Administration.</p>
            </div>
          ` : `
            <div style="border-bottom:1px solid #e2e8f0;padding-bottom:0.75rem;margin-bottom:1rem;">
              <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;">
                <span class="staging-badge">${escapeHtml(activeThreadDetail.thread_reference)} • ${escapeHtml(activeThreadDetail.department)}</span>
                <span class="status-pill ${activeThreadDetail.status === 'resolved' ? 'confirmed' : 'checked_in'}">${escapeHtml(activeThreadDetail.status)}</span>
              </div>
              <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin-top:0.35rem;">${escapeHtml(activeThreadDetail.subject)}</h4>
              ${activeThreadDetail.booking_reference ? `<div style="font-size:0.78rem;color:#64748b;">Linked Reservation: <code>${escapeHtml(activeThreadDetail.booking_reference)}</code></div>` : ''}
            </div>

            <div style="max-height:380px;overflow-y:auto;padding-right:0.25rem;margin-bottom:1rem;">
              ${(activeThreadDetail.messages || []).map((msg) => {
                const isGuest = msg.sender_role === 'guest';
                return `
                  <div style="margin-bottom:0.75rem;display:flex;flex-direction:column;align-items:${isGuest ? 'flex-end' : 'flex-start'};">
                    <div style="max-width:86%;padding:0.75rem 0.95rem;border-radius:10px;background:${isGuest ? '#0b132b' : '#f0fdf4'};color:${isGuest ? '#f8fafc' : '#0f172a'};border:1px solid ${isGuest ? '#1e293b' : '#bbf7d0'};font-size:0.84rem;">
                      <div style="display:flex;justify-content:space-between;gap:1rem;font-size:0.72rem;margin-bottom:0.3rem;color:${isGuest ? '#d4af63' : '#15803d'};font-weight:700;">
                        <span>${escapeHtml(msg.sender_name)} (${escapeHtml(msg.sender_role.toUpperCase())})</span>
                        <span>${escapeHtml(msg.created_at)}</span>
                      </div>
                      <div style="white-space:pre-wrap;line-height:1.5;">${escapeHtml(msg.body)}</div>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>

            <form onsubmit="window.AureliaApp.handleGuestReplyMessageSubmit(event, ${activeThreadDetail.id})" style="border-top:1px solid #e2e8f0;padding-top:0.85rem;">
              <div class="form-group" style="margin-bottom:0.6rem;">
                <label>Reply to Hotel Admin / Concierge *</label>
                <textarea id="gReplyBodyInput" rows="3" placeholder="Write your reply..." required></textarea>
              </div>
              <button type="submit" class="btn-primary" style="width:100%;">Send Reply</button>
            </form>
          `}
        </div>
      </div>
    `;
  }

  async function selectGuestMessageThread(threadId) {
    activeGuestThreadId = Number(threadId);
    await renderGuestPortal();
  }

  async function handleGuestStartMessageSubmit(e) {
    e.preventDefault();
    try {
      const res = await apiFetch('/api/guest/messages', {
        method: 'POST',
        body: JSON.stringify({
          department: document.getElementById('gMsgDept').value,
          bookingReference: document.getElementById('gMsgBookingRef').value,
          subject: document.getElementById('gMsgSubject').value,
          priority: document.getElementById('gMsgPriority').value,
          message: document.getElementById('gMsgBody').value
        })
      });
      activeGuestThreadId = res.thread.id;
      await renderGuestPortal();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleGuestReplyMessageSubmit(e, threadId) {
    e.preventDefault();
    try {
      await apiFetch(`/api/guest/messages/${threadId}/reply`, {
        method: 'POST',
        body: JSON.stringify({
          body: document.getElementById('gReplyBodyInput').value
        })
      });
      activeGuestThreadId = Number(threadId);
      await renderGuestPortal();
    } catch (err) {
      alert(err.message);
    }
  }

  function renderGuestProfileTab(container, dash) {
    const u = dash.user || state.currentUser;
    const notifs = dash.notifications || [];
    container.innerHTML = `
      <div class="checkout-columns">
        <div>
          <div class="kpi-card" style="margin-bottom:1.25rem;">
            <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin-bottom:0.75rem;">Personal Profile &amp; Contact Preferences</h4>
            <form onsubmit="window.AureliaApp.handleSaveGuestProfileSubmit(event)">
              <div class="form-grid-2">
                <div class="form-group">
                  <label>First Name *</label>
                  <input type="text" id="profFirstName" value="${escapeHtml(u.first_name)}" required />
                </div>
                <div class="form-group">
                  <label>Last Name *</label>
                  <input type="text" id="profLastName" value="${escapeHtml(u.last_name)}" required />
                </div>
              </div>
              <div class="form-grid-2">
                <div class="form-group">
                  <label>Phone Number</label>
                  <input type="tel" id="profPhone" value="${escapeHtml(u.phone || '')}" />
                </div>
                <div class="form-group">
                  <label>Country / Residence</label>
                  <input type="text" id="profCountry" value="${escapeHtml(u.country || '')}" />
                </div>
              </div>
              <button type="submit" class="btn-primary" style="width:100%;">Save Profile Details</button>
            </form>
          </div>

          <div class="kpi-card">
            <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin-bottom:0.75rem;">Account Password &amp; Security</h4>
            <form onsubmit="window.AureliaApp.handleChangeGuestPasswordSubmit(event)">
              <div class="form-grid-2">
                <div class="form-group">
                  <label>Current Password *</label>
                  <input type="password" id="profCurrentPass" required />
                </div>
                <div class="form-group">
                  <label>New Password (min. 8 chars) *</label>
                  <input type="password" id="profNewPass" minlength="8" required />
                </div>
              </div>
              <button type="submit" class="btn-secondary" style="width:100%;">Update Password</button>
            </form>
          </div>
        </div>

        <div>
          <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin-bottom:0.75rem;">Transactional &amp; Concierge Notification Inbox (${notifs.length})</h4>
          ${notifs.length === 0 ? `<div class="kpi-card"><p style="font-size:0.84rem;color:#64748b;">No notifications dispatched yet.</p></div>` : notifs.map((n) => `
            <div class="kpi-card" style="margin-bottom:0.75rem;font-size:0.82rem;">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <strong>${escapeHtml(n.subject)}</strong>
                <span class="staging-badge">${escapeHtml(n.template_code)}</span>
              </div>
              <pre style="white-space:pre-wrap;font-family:var(--font-sans);margin-top:0.4rem;color:#475569;">${escapeHtml(n.body)}</pre>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  async function handleCreateConciergeRequestSubmit(e) {
    e.preventDefault();
    try {
      await apiFetch('/api/guest/concierge-requests', {
        method: 'POST',
        body: JSON.stringify({
          category: document.getElementById('concCategory').value,
          bookingReference: document.getElementById('concBookingRef').value,
          priority: document.getElementById('concPriority').value,
          preferredTime: document.getElementById('concPrefTime').value,
          subject: document.getElementById('concSubject').value,
          details: document.getElementById('concDetails').value
        })
      });
      await renderGuestPortal();
    } catch (err) {
      alert(err.message);
    }
  }

  async function cancelGuestWaitlistEntry(id) {
    try {
      await apiFetch(`/api/guest/waitlist/${id}`, { method: 'DELETE' });
      await renderGuestPortal();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleSaveGuestProfileSubmit(e) {
    e.preventDefault();
    try {
      const res = await apiFetch('/api/guest/profile', {
        method: 'PUT',
        body: JSON.stringify({
          firstName: document.getElementById('profFirstName').value,
          lastName: document.getElementById('profLastName').value,
          phone: document.getElementById('profPhone').value,
          country: document.getElementById('profCountry').value
        })
      });
      state.currentUser = res.user;
      alert('Profile updated successfully.');
      await renderGuestPortal();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleChangeGuestPasswordSubmit(e) {
    e.preventDefault();
    try {
      await apiFetch('/api/guest/password', {
        method: 'PUT',
        body: JSON.stringify({
          currentPassword: document.getElementById('profCurrentPass').value,
          newPassword: document.getElementById('profNewPass').value
        })
      });
      alert('Password updated successfully.');
      document.getElementById('profCurrentPass').value = '';
      document.getElementById('profNewPass').value = '';
    } catch (err) {
      alert(err.message);
    }
  }

  // -------------------------------------------------------------------------
  // View 4: Hotel Administration Dashboard (RBAC Staff Console)
  // -------------------------------------------------------------------------

  async function quickStaffLogin(email, password) {
    try {
      const data = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });
      state.authToken = data.token;
      state.currentUser = data.user;
      localStorage.setItem('aurelia_auth_token', data.token);
      updateAdminRoleHeader();
      await loadAdminTab(state.currentAdminTab);
    } catch (err) {
      alert(err.message);
    }
  }

  async function ensureStaffForAdminAndLoad() {
    const staffRoles = ['receptionist', 'finance', 'manager', 'admin'];
    if (!state.currentUser || !staffRoles.includes(state.currentUser.role)) {
      // Automatically sign in with the default Admin account in staging so the Admin Dashboard is immediately interactive
      await quickStaffLogin('admin@maisonaurelia.luxury', 'AureliaAdmin!2026');
      return;
    }
    updateAdminRoleHeader();
    await loadAdminTab(state.currentAdminTab);
  }

  function updateAdminRoleHeader() {
    const el = document.getElementById('adminCurrentRoleDisplay');
    if (!el || !state.currentUser) return;
    el.innerHTML = `Signed in as: <strong>${escapeHtml(state.currentUser.first_name)} ${escapeHtml(state.currentUser.last_name)}</strong> (${escapeHtml(state.currentUser.email)}) • Active RBAC Role: <strong style="color:var(--gold-bright);text-transform:uppercase;">${escapeHtml(state.currentUser.role)}</strong>`;
  }

  async function switchAdminTab(tabName, btnEl = null) {
    state.currentAdminTab = tabName;
    if (btnEl) {
      document.querySelectorAll('.admin-tab-btn').forEach((b) => b.classList.remove('active'));
      btnEl.classList.add('active');
    }
    await loadAdminTab(tabName);
  }

  let adminEventSource = null;

  function ensureAdminSseConnected() {
    if (adminEventSource || typeof window.EventSource === 'undefined') return;
    try {
      adminEventSource = new window.EventSource('/api/admin/events');
      adminEventSource.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data);
          const tickerEl = document.getElementById('adminLiveSseTicker');
          if (tickerEl) {
            if (data.type === 'CONNECTED') {
              const latest = (data.recentEvents && data.recentEvents[0]) || null;
              tickerEl.innerHTML = latest
                ? `🟢 <strong>Live Front-Desk SSE Stream Active</strong> — Latest: <code>${escapeHtml(latest.type)}</code> ${escapeHtml(latest.title)} (${escapeHtml(latest.message)})`
                : `🟢 <strong>Live Front-Desk SSE Stream Active</strong> — Listening for real-time reservations, waitlist alerts &amp; housekeeping updates...`;
            } else {
              tickerEl.innerHTML = `🟢 <strong>Live Event [${escapeHtml(data.type)}]</strong>: ${escapeHtml(data.title)} — ${escapeHtml(data.message)}`;
            }
          }
        } catch (_) {}
      };
    } catch (_) {}
  }

  async function loadAdminTab(tabName) {
    const container = document.getElementById('adminTabContent');
    if (!container) return;

    ensureAdminSseConnected();
    if (!document.getElementById('adminLiveSseTicker')) {
      const ticker = document.createElement('div');
      ticker.id = 'adminLiveSseTicker';
      ticker.style.cssText = 'background:#0b132b;color:#f8fafc;padding:0.6rem 1rem;border-radius:6px;margin-bottom:1.1rem;font-size:0.8rem;border-left:4px solid #c5a059;';
      ticker.innerHTML = '🟢 <strong>Live Front-Desk SSE Stream Active</strong> — Connected to <code>/api/admin/events</code>';
      container.parentNode.insertBefore(ticker, container);
    }

    try {
      if (tabName === 'overview') {
        await renderAdminOverviewTab(container);
      } else if (tabName === 'reservations') {
        await renderAdminReservationsTab(container);
      } else if (tabName === 'rooms') {
        await renderAdminRoomsTab(container);
      } else if (tabName === 'calendar') {
        await renderAdminCalendarTab(container);
      } else if (tabName === 'settings') {
        await renderAdminSettingsTab(container);
      } else if (tabName === 'users') {
        await renderAdminUsersTab(container);
      } else if (tabName === 'messages') {
        await renderAdminMessagesTab(container);
      } else if (tabName === 'audit') {
        await renderAdminAuditTab(container);
      }
    } catch (err) {
      container.innerHTML = `
        <div class="availability-box is-unavailable">
          <div class="availability-box-heading">RBAC Access Control Notice (${err.status || 403})</div>
          <p>${escapeHtml(err.message)}</p>
        </div>
      `;
    }
  }

  async function renderAdminOverviewTab(container) {
    const data = await apiFetch('/api/admin/overview');
    const m = data.metrics;

    container.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">Physical Inventory</div>
          <div class="kpi-value">${m.availableStatusRooms} / ${m.totalRooms}</div>
          <div style="font-size:0.75rem;color:#64748b;">Available Rooms (${m.maintenanceStatusRooms} in maintenance)</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Live Occupancy Today</div>
          <div class="kpi-value">${m.occupancyRatePercent}%</div>
          <div style="font-size:0.75rem;color:#64748b;">${m.occupiedToday} occupied • ${m.activeHoldsCount} active checkout holds</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Contracted Revenue</div>
          <div class="kpi-value">$${m.contractedRevenue.toLocaleString()}</div>
          <div style="font-size:0.75rem;color:#64748b;">${m.activeBookings} active bookings (${m.roomNightsSold} room-nights)</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Net Collected Revenue</div>
          <div class="kpi-value" style="color:var(--emerald-ok);">$${m.netCollected.toLocaleString()}</div>
          <div style="font-size:0.75rem;color:#64748b;">Gross: $${m.grossCollected.toLocaleString()} • Refunded: $${m.totalRefunded.toLocaleString()}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">ADR &amp; RevPAR</div>
          <div class="kpi-value">$${m.averageDailyRate.toLocaleString()}</div>
          <div style="font-size:0.75rem;color:#64748b;">ADR • RevPAR: $${m.revPar.toLocaleString()}</div>
        </div>
      </div>

      <div class="checkout-columns">
        <div>
          <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin-bottom:0.75rem;">Upcoming Confirmed Arrivals</h4>
          <div class="data-table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Guest</th>
                  <th>Check-In &rarr; Out</th>
                  <th>Status</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                ${(data.upcomingArrivals || []).length === 0 ? '<tr><td colspan="5">No upcoming arrivals yet.</td></tr>' : data.upcomingArrivals.map((r) => `
                  <tr>
                    <td><code>${escapeHtml(r.booking_reference)}</code></td>
                    <td>${escapeHtml(r.guest_first_name)} ${escapeHtml(r.guest_last_name)}</td>
                    <td>${escapeHtml(r.check_in)} &rarr; ${escapeHtml(r.check_out)}</td>
                    <td><span class="status-pill ${escapeHtml(r.status)}">${escapeHtml(r.status)}</span></td>
                    <td><strong>$${Number(r.total_amount).toFixed(2)}</strong></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin-bottom:0.75rem;">Revenue by Suite Category</h4>
          <div class="data-table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Room Bookings</th>
                  <th>Revenue (USD)</th>
                </tr>
              </thead>
              <tbody>
                ${(data.revenueByCategory || []).length === 0 ? '<tr><td colspan="3">Book a room to populate category revenue analytics.</td></tr>' : data.revenueByCategory.map((c) => `
                  <tr>
                    <td><strong>${escapeHtml(c.categoryName)}</strong></td>
                    <td>${c.bookingsCount}</td>
                    <td><strong>$${Number(c.categoryRevenue).toFixed(2)}</strong></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }

  async function renderAdminReservationsTab(container) {
    const [resData, catData, waitlistData] = await Promise.all([
      apiFetch('/api/admin/reservations'),
      apiFetch('/api/catalogue'),
      apiFetch('/api/admin/waitlist').catch(() => ({ waitlist: [] }))
    ]);

    container.innerHTML = `
      <div class="checkout-columns" style="margin-bottom:2rem;">
        <div class="kpi-card" style="grid-column:1 / -1;">
          <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin-bottom:0.75rem;">Create Authorised Walk-In / Staff Reservation</h4>
          <form onsubmit="window.AureliaApp.handleAdminWalkInSubmit(event)" class="search-grid">
            <div class="search-field">
              <label>Physical Room</label>
              <select id="walkInRoomId" required>
                ${catData.rooms.filter((r) => r.status === 'available').map((r) => `
                  <option value="${r.id}">#${escapeHtml(r.roomNumber)} — ${escapeHtml(r.name)} ($${r.pricePerNight}/n)</option>
                `).join('')}
              </select>
            </div>
            <div class="search-field">
              <label>Check-In</label>
              <input type="date" id="walkInCheckIn" value="${state.searchParams.checkIn}" required />
            </div>
            <div class="search-field">
              <label>Check-Out</label>
              <input type="date" id="walkInCheckOut" value="${state.searchParams.checkOut}" required />
            </div>
            <div class="search-field">
              <label>Guest First Name</label>
              <input type="text" id="walkInFirstName" placeholder="Victoria" required />
            </div>
            <div class="search-field">
              <label>Guest Last Name</label>
              <input type="text" id="walkInLastName" placeholder="Beckham" required />
            </div>
            <div class="search-field">
              <label>Guest Email</label>
              <input type="email" id="walkInEmail" placeholder="vip@guest.com" required />
            </div>
            <div class="search-field">
              <label>Guest Phone</label>
              <input type="tel" id="walkInPhone" value="+41 22 999 0000" required />
            </div>
            <div class="search-field">
              <button type="submit" class="btn-primary" style="width:100%;">Confirm Walk-In</button>
            </div>
          </form>
        </div>

        <!-- Post In-Stay Incidental Folio Charge -->
        <div class="kpi-card" style="grid-column:1 / -1;">
          <h4 style="font-family:var(--font-serif);font-size:1.3rem;margin-bottom:0.65rem;">Post In-Stay Incidental Folio Charge (Room Service, Sommelier Cellar, Thermal Spa)</h4>
          <form onsubmit="window.AureliaApp.handlePostFolioChargeSubmit(event)" class="search-grid">
            <div class="search-field">
              <label>Booking Reference</label>
              <select id="folioBookingRef" required>
                ${resData.reservations.filter((r) => r.status !== 'cancelled').map((r) => `
                  <option value="${escapeHtml(r.booking_reference)}">${escapeHtml(r.booking_reference)} — ${escapeHtml(r.guest_first_name)} ${escapeHtml(r.guest_last_name)}</option>
                `).join('')}
              </select>
            </div>
            <div class="search-field">
              <label>Department</label>
              <select id="folioCategory">
                <option value="In-Suite Dining">24h In-Suite Dining</option>
                <option value="Le Jardin d’Or Restaurant">Le Jardin d’Or (Michelin)</option>
                <option value="Sommelier Wine Cellar">Sommelier Wine Cellar</option>
                <option value="Thermal Spa & Wellness">Thermal Spa &amp; Cryo</option>
                <option value="Chauffeur & Aviation">Chauffeur &amp; Helipad</option>
              </select>
            </div>
            <div class="search-field">
              <label>Item / Service Description</label>
              <input type="text" id="folioDesc" value="Dom Pérignon Vintage 2013 &amp; Oscietra Caviar Service" required />
            </div>
            <div class="search-field">
              <label>Unit Price (USD)</label>
              <input type="number" step="0.01" id="folioUnitPrice" value="390" min="1" required />
            </div>
            <div class="search-field">
              <label>Qty</label>
              <input type="number" id="folioQty" value="1" min="1" required />
            </div>
            <div class="search-field">
              <button type="submit" class="btn-secondary" style="width:100%;">Post to Guest Folio</button>
            </div>
          </form>
        </div>
      </div>

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;flex-wrap:wrap;gap:0.5rem;">
        <h4 style="font-family:var(--font-serif);font-size:1.35rem;">All Reservations Ledger (${resData.reservations.length})</h4>
        <div style="display:flex;gap:0.5rem;">
          <a href="/api/admin/reports/export?format=csv" target="_blank" class="btn-secondary" style="text-decoration:none;padding:0.45rem 0.85rem;font-size:0.8rem;">⬇ Export CSV Report</a>
        </div>
      </div>

      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Ref &amp; Source</th>
              <th>Guest</th>
              <th>Room(s)</th>
              <th>Stay Dates</th>
              <th>Stay Status</th>
              <th>Payment Status</th>
              <th>Financials (USD)</th>
              <th>Staff Actions</th>
            </tr>
          </thead>
          <tbody>
            ${resData.reservations.length === 0 ? '<tr><td colspan="8">No reservations recorded yet.</td></tr>' : resData.reservations.map((r) => `
              <tr>
                <td>
                  <strong><code>${escapeHtml(r.booking_reference)}</code></strong><br/>
                  <span style="font-size:0.72rem;color:#64748b;">${escapeHtml(r.booking_source)}</span>
                </td>
                <td>
                  ${escapeHtml(r.guest_first_name)} ${escapeHtml(r.guest_last_name)}<br/>
                  <span style="font-size:0.75rem;color:#64748b;">${escapeHtml(r.guest_email)}</span>
                </td>
                <td>${(r.rooms || []).map((rm) => `#${escapeHtml(rm.room_number)}`).join(', ')}</td>
                <td>${escapeHtml(r.check_in)} &rarr; ${escapeHtml(r.check_out)} (${r.nights}n)</td>
                <td><span class="status-pill ${escapeHtml(r.status)}">${escapeHtml(r.status)}</span></td>
                <td><span class="status-pill ${escapeHtml(r.payment_status)}">${escapeHtml(r.payment_status)}</span></td>
                <td>
                  Stay: <strong>$${Number(r.total_amount).toFixed(2)}</strong>
                  ${r.incidentalTotal > 0 ? `<br/>Folio Extras: <strong>+$${Number(r.incidentalTotal).toFixed(2)}</strong>` : ''}
                  <br/>Paid: $${Number(r.amount_paid).toFixed(2)}
                  ${r.refunded_amount > 0 ? `<br/><span style="color:var(--crimson-err);">Refunded: $${Number(r.refunded_amount).toFixed(2)}</span>` : ''}
                </td>
                <td>
                  <div style="display:flex;gap:0.35rem;flex-wrap:wrap;">
                    <a href="/api/bookings/${encodeURIComponent(r.booking_reference)}/invoice?format=html" target="_blank" class="nearby-date-btn" style="text-decoration:none;">Invoice</a>
                    ${r.status === 'confirmed' ? `<button type="button" class="nearby-date-btn" style="border-color:var(--emerald-ok);color:var(--emerald-ok);" onclick="window.AureliaApp.adminUpdateBookingStatus('${escapeHtml(r.booking_reference)}', 'checked_in')">Check-In</button>` : ''}
                    ${r.status === 'checked_in' ? `<button type="button" class="nearby-date-btn" onclick="window.AureliaApp.adminUpdateBookingStatus('${escapeHtml(r.booking_reference)}', 'checked_out')">Check-Out</button>` : ''}
                    ${r.status !== 'cancelled' && r.amount_paid < (r.grandFolioTotal || r.total_amount) ? `<button type="button" class="nearby-date-btn" style="border-color:#2563eb;color:#2563eb;" onclick="window.AureliaApp.adminConfirmBalancePayment('${escapeHtml(r.booking_reference)}')">Confirm Payment</button>` : ''}
                    ${r.amount_paid > r.refunded_amount ? `<button type="button" class="nearby-date-btn" onclick="window.AureliaApp.adminIssueRefund('${escapeHtml(r.booking_reference)}')">Issue Refund</button>` : ''}
                    ${r.status !== 'cancelled' && r.status !== 'checked_out' ? `<button type="button" class="nearby-date-btn" onclick="window.AureliaApp.promptCancelReservation('${escapeHtml(r.booking_reference)}', '${escapeHtml(r.guest_email)}')">Cancel</button>` : ''}
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <!-- AutomatedWaitlistAndRoomAlertModule Admin Queue -->
      <div style="margin-top:2rem;">
        <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin-bottom:0.65rem;">Priority Room Waitlist &amp; Automated Release Alerts (${(waitlistData.waitlist || []).length})</h4>
        <div class="data-table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>Waitlist Ref</th>
                <th>Guest</th>
                <th>Target Room / Category</th>
                <th>Requested Dates</th>
                <th>Alert Status</th>
              </tr>
            </thead>
            <tbody>
              ${(waitlistData.waitlist || []).length === 0 ? '<tr><td colspan="5">No active priority waitlist entries.</td></tr>' : waitlistData.waitlist.map((w) => `
                <tr>
                  <td><code>${escapeHtml(w.waitlist_reference)}</code></td>
                  <td><strong>${escapeHtml(w.guest_name)}</strong> (${escapeHtml(w.guest_email)})</td>
                  <td>${w.room_number ? `Room #${escapeHtml(w.room_number)}` : escapeHtml(w.category_name || 'Any Suite')}</td>
                  <td>${escapeHtml(w.check_in)} &rarr; ${escapeHtml(w.check_out)}</td>
                  <td><span class="status-pill ${w.status === 'notified' ? 'confirmed' : 'checked_in'}">${escapeHtml(w.status)}</span> ${w.notified_at ? `(${escapeHtml(w.notified_at)})` : ''}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  async function handleAdminWalkInSubmit(e) {
    e.preventDefault();
    try {
      await apiFetch('/api/admin/reservations/walk-in', {
        method: 'POST',
        body: JSON.stringify({
          roomIds: [Number(document.getElementById('walkInRoomId').value)],
          checkIn: document.getElementById('walkInCheckIn').value,
          checkOut: document.getElementById('walkInCheckOut').value,
          guestFirstName: document.getElementById('walkInFirstName').value,
          guestLastName: document.getElementById('walkInLastName').value,
          guestEmail: document.getElementById('walkInEmail').value,
          guestPhone: document.getElementById('walkInPhone').value,
          paymentMethod: 'pay_at_hotel'
        })
      });
      await loadAdminTab('reservations');
      await performAvailabilitySearch();
    } catch (err) {
      alert(err.message);
    }
  }

  async function adminUpdateBookingStatus(ref, status) {
    try {
      await apiFetch(`/api/admin/reservations/${encodeURIComponent(ref)}/status`, {
        method: 'POST',
        body: JSON.stringify({ status })
      });
      await loadAdminTab('reservations');
    } catch (err) {
      alert(err.message);
    }
  }

  async function adminConfirmBalancePayment(ref) {
    try {
      await apiFetch(`/api/admin/reservations/${encodeURIComponent(ref)}/confirm-payment`, {
        method: 'POST',
        body: JSON.stringify({})
      });
      await loadAdminTab('reservations');
    } catch (err) {
      alert(err.message);
    }
  }

  async function adminIssueRefund(ref) {
    try {
      await apiFetch(`/api/admin/reservations/${encodeURIComponent(ref)}/refund`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Staff authorised refund' })
      });
      await loadAdminTab('reservations');
    } catch (err) {
      alert(err.message);
    }
  }

  async function handlePostFolioChargeSubmit(e) {
    e.preventDefault();
    try {
      const ref = document.getElementById('folioBookingRef').value;
      await apiFetch(`/api/admin/reservations/${encodeURIComponent(ref)}/folio`, {
        method: 'POST',
        body: JSON.stringify({
          category: document.getElementById('folioCategory').value,
          description: document.getElementById('folioDesc').value,
          unitPrice: Number(document.getElementById('folioUnitPrice').value),
          quantity: Number(document.getElementById('folioQty').value)
        })
      });
      await loadAdminTab('reservations');
    } catch (err) {
      alert(err.message);
    }
  }

  async function renderAdminRoomsTab(container) {
    const catData = await apiFetch('/api/catalogue');

    container.innerHTML = `
      <div class="checkout-columns" style="margin-bottom:2rem;">
        <!-- Add Physical Room Form -->
        <div class="kpi-card">
          <h4 style="font-family:var(--font-serif);font-size:1.3rem;margin-bottom:0.75rem;">Add New Physical Room to Inventory</h4>
          <form onsubmit="window.AureliaApp.handleAddRoomSubmit(event)">
            <div class="form-grid-2">
              <div class="form-group">
                <label>Room Number *</label>
                <input type="text" id="newRoomNumber" placeholder="e.g. 601" required />
              </div>
              <div class="form-group">
                <label>Category *</label>
                <select id="newRoomCategoryId" required>
                  ${catData.categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)} ($${c.basePrice})</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="form-group">
              <label>Room / Suite Title *</label>
              <input type="text" id="newRoomName" placeholder="e.g. Royal Lakefront Suite #601" required />
            </div>
            <div class="form-grid-2">
              <div class="form-group">
                <label>Nightly Price (USD) *</label>
                <input type="number" id="newRoomPrice" value="950" min="50" required />
              </div>
              <div class="form-group">
                <label>Floor</label>
                <input type="number" id="newRoomFloor" value="6" min="1" required />
              </div>
            </div>
            <div class="form-grid-2">
              <div class="form-group">
                <label>Max Occupancy</label>
                <input type="number" id="newRoomMaxOcc" value="3" min="1" required />
              </div>
              <div class="form-group">
                <label>Size (m²)</label>
                <input type="number" id="newRoomSizeSqm" value="75" min="20" required />
              </div>
            </div>
            <button type="submit" class="btn-primary" style="width:100%;">Add Physical Room</button>
          </form>
        </div>

        <!-- Add Room Category Form -->
        <div class="kpi-card">
          <h4 style="font-family:var(--font-serif);font-size:1.3rem;margin-bottom:0.75rem;">Create New Room Category</h4>
          <form onsubmit="window.AureliaApp.handleAddCategorySubmit(event)">
            <div class="form-grid-2">
              <div class="form-group">
                <label>Category Name *</label>
                <input type="text" id="newCatName" placeholder="e.g. Diplomatic Villas" required />
              </div>
              <div class="form-group">
                <label>Base Nightly Rate (USD) *</label>
                <input type="number" id="newCatPrice" value="2200" min="50" required />
              </div>
            </div>
            <div class="form-group">
              <label>Short Description *</label>
              <input type="text" id="newCatShortDesc" placeholder="Private lakeside villas with dedicated security..." required />
            </div>
            <div class="form-grid-2">
              <div class="form-group">
                <label>Bed Configuration</label>
                <input type="text" id="newCatBed" value="2 Emperor King Beds" required />
              </div>
              <div class="form-group">
                <label>Size (m²)</label>
                <input type="number" id="newCatSqm" value="180" required />
              </div>
            </div>
            <button type="submit" class="btn-secondary" style="width:100%;">Create Category</button>
          </form>
        </div>
      </div>

      <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin-bottom:0.75rem;">Configured Physical Rooms &amp; Housekeeping Turnover Board (${catData.rooms.length})</h4>
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Room #</th>
              <th>Name &amp; Category</th>
              <th>Floor / Wing</th>
              <th>Nightly Rate (USD)</th>
              <th>Inventory Status</th>
              <th>Housekeeping Readiness (Required for Check-In)</th>
              <th>iCal Sync</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${catData.rooms.map((r) => `
              <tr>
                <td><strong>#${escapeHtml(r.roomNumber)}</strong><br/><code>${escapeHtml(r.uniqueCode)}</code></td>
                <td>
                  <strong>${escapeHtml(r.name)}</strong><br/>
                  <span style="font-size:0.75rem;color:#64748b;">${escapeHtml(r.categoryName)} • ${r.maxOccupancy} guests</span>
                </td>
                <td>Floor ${r.floor} • ${escapeHtml(r.wing)}</td>
                <td>
                  <input type="number" id="rateEdit_${r.id}" value="${r.pricePerNight}" style="width:85px;padding:0.25rem;" />
                </td>
                <td>
                  <select id="statusEdit_${r.id}" style="padding:0.25rem;">
                    <option value="available" ${r.status === 'available' ? 'selected' : ''}>available</option>
                    <option value="maintenance" ${r.status === 'maintenance' ? 'selected' : ''}>maintenance</option>
                    <option value="inactive" ${r.status === 'inactive' ? 'selected' : ''}>inactive</option>
                  </select>
                </td>
                <td>
                  <select id="hkEdit_${r.id}" style="padding:0.25rem;" onchange="window.AureliaApp.saveRoomHousekeepingStatus(${r.id}, this.value)">
                    <option value="clean_inspected" ${r.housekeepingStatus === 'clean_inspected' ? 'selected' : ''}>✓ Clean &amp; Inspected</option>
                    <option value="turndown_complete" ${r.housekeepingStatus === 'turndown_complete' ? 'selected' : ''}>✓ Turndown Complete</option>
                    <option value="dirty_turnover" ${r.housekeepingStatus === 'dirty_turnover' ? 'selected' : ''}>⚠ Dirty / Turnover Needed</option>
                    <option value="deep_cleaning" ${r.housekeepingStatus === 'deep_cleaning' ? 'selected' : ''}>🛠 In Deep Cleaning</option>
                  </select>
                </td>
                <td>
                  <a href="/api/rooms/${r.id}/calendar.ics" target="_blank" style="font-size:0.75rem;color:var(--gold-primary);">.ics Feed</a>
                </td>
                <td>
                  <button type="button" class="nearby-date-btn" style="border-color:var(--emerald-ok);color:var(--emerald-ok);" onclick="window.AureliaApp.saveRoomQuickEdit(${r.id})">Save</button>
                  <button type="button" class="nearby-date-btn" onclick="window.AureliaApp.deletePhysicalRoom(${r.id})">Delete</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <!-- HousekeepingStaffAssignmentAndChecklistModule UI -->
      <div class="kpi-card" style="margin-top:1.75rem;">
        <h4 style="font-family:var(--font-serif);font-size:1.3rem;margin-bottom:0.65rem;">Housekeeping Attendant Assignment &amp; Suite Inspection Checklist</h4>
        <form onsubmit="window.AureliaApp.handleHousekeepingChecklistSubmit(event)" class="search-grid">
          <div class="search-field">
            <label>Physical Room</label>
            <select id="hkChkRoomId" required>
              ${catData.rooms.map((r) => `<option value="${r.id}">#${escapeHtml(r.roomNumber)} — ${escapeHtml(r.name)}</option>`).join('')}
            </select>
          </div>
          <div class="search-field">
            <label>Assigned Attendant</label>
            <input type="text" id="hkChkAttendant" value="Marie-Claire Laurent" required />
          </div>
          <div class="search-field">
            <label>Target Readiness Status</label>
            <select id="hkChkStatus">
              <option value="clean_inspected">✓ Clean &amp; Inspected</option>
              <option value="turndown_complete">✓ Evening Turndown Complete</option>
              <option value="in_progress">🛠 In Progress</option>
              <option value="dirty_turnover">⚠ Dirty / Turnover Needed</option>
            </select>
          </div>
          <div class="search-field">
            <label>Inspection Notes (Linen / Marble / Minibar / Florals)</label>
            <input type="text" id="hkChkNotes" value="Quagliotti linens changed, Calacatta marble sanitised, Krug minibar restocked" />
          </div>
          <div class="search-field">
            <button type="submit" class="btn-primary" style="width:100%;">Submit Inspection Checklist</button>
          </div>
        </form>
      </div>
    `;
  }

  async function handleHousekeepingChecklistSubmit(e) {
    e.preventDefault();
    try {
      const roomId = Number(document.getElementById('hkChkRoomId').value);
      await apiFetch(`/api/admin/rooms/${roomId}/housekeeping-checklist`, {
        method: 'POST',
        body: JSON.stringify({
          attendantName: document.getElementById('hkChkAttendant').value,
          housekeepingStatus: document.getElementById('hkChkStatus').value,
          notes: document.getElementById('hkChkNotes').value,
          linenChanged: true,
          marbleSanitised: true,
          minibarRestocked: true,
          floralsRefreshed: true,
          supervisorVerified: true
        })
      });
      await loadAdminTab('rooms');
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleAddRoomSubmit(e) {
    e.preventDefault();
    try {
      const sqm = Number(document.getElementById('newRoomSizeSqm').value || 65);
      await apiFetch('/api/admin/rooms', {
        method: 'POST',
        body: JSON.stringify({
          roomNumber: document.getElementById('newRoomNumber').value,
          categoryId: Number(document.getElementById('newRoomCategoryId').value),
          name: document.getElementById('newRoomName').value,
          pricePerNight: Number(document.getElementById('newRoomPrice').value),
          floor: Number(document.getElementById('newRoomFloor').value),
          maxOccupancy: Number(document.getElementById('newRoomMaxOcc').value),
          maxAdults: Number(document.getElementById('newRoomMaxOcc').value),
          sizeSqm: sqm,
          sizeSqft: Math.round(sqm * 10.764)
        })
      });
      await loadAdminTab('rooms');
      await performAvailabilitySearch();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleAddCategorySubmit(e) {
    e.preventDefault();
    try {
      const sqm = Number(document.getElementById('newCatSqm').value || 90);
      await apiFetch('/api/admin/categories', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('newCatName').value,
          basePrice: Number(document.getElementById('newCatPrice').value),
          shortDescription: document.getElementById('newCatShortDesc').value,
          description: document.getElementById('newCatShortDesc').value,
          bedType: document.getElementById('newCatBed').value,
          sizeSqm: sqm,
          sizeSqft: Math.round(sqm * 10.764)
        })
      });
      await loadAdminTab('rooms');
      await performAvailabilitySearch();
    } catch (err) {
      alert(err.message);
    }
  }

  async function saveRoomQuickEdit(roomId) {
    try {
      const pricePerNight = Number(document.getElementById(`rateEdit_${roomId}`).value);
      const status = document.getElementById(`statusEdit_${roomId}`).value;
      await apiFetch(`/api/admin/rooms/${roomId}`, {
        method: 'PUT',
        body: JSON.stringify({ pricePerNight, status })
      });
      await loadAdminTab('rooms');
      await performAvailabilitySearch();
    } catch (err) {
      alert(err.message);
    }
  }

  async function saveRoomHousekeepingStatus(roomId, housekeepingStatus) {
    try {
      await apiFetch(`/api/admin/rooms/${roomId}/housekeeping`, {
        method: 'PATCH',
        body: JSON.stringify({ housekeepingStatus })
      });
      await loadAdminTab('rooms');
    } catch (err) {
      alert(err.message);
    }
  }

  async function deletePhysicalRoom(roomId) {
    try {
      await apiFetch(`/api/admin/rooms/${roomId}`, { method: 'DELETE' });
      await loadAdminTab('rooms');
      await performAvailabilitySearch();
    } catch (err) {
      alert(err.message);
    }
  }

  async function renderAdminCalendarTab(container) {
    const [cal, tape] = await Promise.all([
      apiFetch('/api/admin/calendar'),
      apiFetch(`/api/admin/tape-chart?startDate=${encodeURIComponent(state.searchParams.checkIn)}&days=14`)
    ]);

    container.innerHTML = `
      <!-- Visual 14-Day Front-Desk Tape Chart (Gantt Availability Grid) -->
      <div class="kpi-card" style="margin-bottom:1.75rem;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;flex-wrap:wrap;gap:0.5rem;">
          <div>
            <h4 style="font-family:var(--font-serif);font-size:1.35rem;">Visual 14-Day Front-Desk Tape Chart (Gantt Matrix)</h4>
            <p style="font-size:0.78rem;color:#64748b;">Window: ${escapeHtml(tape.startDate)} to ${escapeHtml(tape.endDate)} • Green = Available / Checked-In • Blue = Confirmed Stay • Amber = Checkout Hold • Red = Maintenance</p>
          </div>
        </div>
        <div class="data-table-wrapper">
          <table class="data-table tape-chart-table">
            <thead>
              <tr>
                <th style="text-align:left;">Room # &amp; HK</th>
                ${tape.dateHeaders.map((d) => `<th>${escapeHtml(d.slice(5))}</th>`).join('')}
              </tr>
            </thead>
            <tbody>
              ${tape.rows.map((row) => `
                <tr>
                  <td style="text-align:left;font-weight:700;">
                    #${escapeHtml(row.roomNumber)}
                    <span class="hk-badge ${escapeHtml(row.housekeepingStatus)}" style="margin-left:0.25rem;">${escapeHtml(row.housekeepingStatus.split('_')[0])}</span>
                  </td>
                  ${row.cells.map((cell) => `
                    <td class="tape-cell-${escapeHtml(cell.state)}" title="${escapeHtml(cell.label)}">
                      ${escapeHtml(cell.state === 'available' ? cell.label : cell.state === 'booked' || cell.state === 'checked_in' ? (cell.bookingReference || 'Booked') : cell.state.toUpperCase())}
                    </td>
                  `).join('')}
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="kpi-card" style="margin-bottom:1.75rem;">
        <h4 style="font-family:var(--font-serif);font-size:1.3rem;margin-bottom:0.75rem;">Schedule Room Maintenance Closure Block</h4>
        <form onsubmit="window.AureliaApp.handleCreateMaintenanceSubmit(event)" class="search-grid">
          <div class="search-field">
            <label>Physical Room</label>
            <select id="maintRoomId" required>
              ${cal.rooms.map((r) => `<option value="${r.id}">#${escapeHtml(r.room_number)} — ${escapeHtml(r.name)}</option>`).join('')}
            </select>
          </div>
          <div class="search-field">
            <label>Start Date</label>
            <input type="date" id="maintStartDate" value="${state.searchParams.checkIn}" required />
          </div>
          <div class="search-field">
            <label>End Date</label>
            <input type="date" id="maintEndDate" value="${state.searchParams.checkOut}" required />
          </div>
          <div class="search-field">
            <label>Maintenance Reason</label>
            <input type="text" id="maintReason" value="Annual Marble Polishing &amp; HVAC Inspection" required />
          </div>
          <div class="search-field">
            <button type="submit" class="btn-primary" style="width:100%;">Block Room Dates</button>
          </div>
        </form>
      </div>

      <!-- InboundIcalChannelSyncModule UI -->
      <div class="kpi-card" style="margin-bottom:1.75rem;">
        <h4 style="font-family:var(--font-serif);font-size:1.3rem;margin-bottom:0.5rem;">Inbound iCal Channel Sync Importer (Virtuoso / Amex FHR / OTA)</h4>
        <p style="font-size:0.8rem;color:#64748b;margin-bottom:0.75rem;">
          Paste an external RFC 5545 <code>.ics</code> calendar payload to automatically import external channel blocks into the room availability calendar while preventing overlapping double bookings.
        </p>
        <form onsubmit="window.AureliaApp.handleImportIcalSubmit(event)" class="search-grid">
          <div class="search-field">
            <label>Target Physical Room</label>
            <select id="icalRoomId" required>
              ${cal.rooms.map((r) => `<option value="${r.id}">#${escapeHtml(r.room_number)} — ${escapeHtml(r.name)}</option>`).join('')}
            </select>
          </div>
          <div class="search-field">
            <label>External Channel Name</label>
            <input type="text" id="icalChannelName" value="Virtuoso Luxury Network" required />
          </div>
          <div class="search-field" style="grid-column:span 2;">
            <label>RFC 5545 .ics VEVENT Payload</label>
            <textarea id="icalContentInput" rows="2" style="width:100%;font-family:monospace;font-size:0.75rem;">BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261210
DTEND;VALUE=DATE:20261213
SUMMARY:Virtuoso VIP Hold
END:VEVENT
END:VCALENDAR</textarea>
          </div>
          <div class="search-field">
            <button type="submit" class="btn-primary" style="width:100%;">Import .ics Feed</button>
          </div>
        </form>
      </div>

      <div class="checkout-columns">
        <div>
          <h4 style="font-family:var(--font-serif);font-size:1.3rem;margin-bottom:0.75rem;">Active Maintenance Closures (${cal.maintenanceBlocks.length})</h4>
          <div class="data-table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Room</th>
                  <th>Dates</th>
                  <th>Reason</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                ${cal.maintenanceBlocks.length === 0 ? '<tr><td colspan="4">No active maintenance blocks.</td></tr>' : cal.maintenanceBlocks.map((mb) => `
                  <tr>
                    <td><strong>#${escapeHtml(mb.room_number)}</strong></td>
                    <td>${escapeHtml(mb.start_date)} &rarr; ${escapeHtml(mb.end_date)}</td>
                    <td>${escapeHtml(mb.reason)}</td>
                    <td><button type="button" class="nearby-date-btn" onclick="window.AureliaApp.removeMaintenanceBlock(${mb.id})">Release Block</button></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h4 style="font-family:var(--font-serif);font-size:1.3rem;margin-bottom:0.75rem;">Active Expiring Checkout Holds (${cal.activeHolds.length})</h4>
          <div class="data-table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Hold Token</th>
                  <th>Room</th>
                  <th>Dates</th>
                  <th>Expires At (UTC)</th>
                </tr>
              </thead>
              <tbody>
                ${cal.activeHolds.length === 0 ? '<tr><td colspan="4">No active guest checkout holds right now.</td></tr>' : cal.activeHolds.map((h) => `
                  <tr>
                    <td><code>${escapeHtml(h.hold_token)}</code></td>
                    <td><strong>#${escapeHtml(h.room_number)}</strong></td>
                    <td>${escapeHtml(h.check_in)} &rarr; ${escapeHtml(h.check_out)}</td>
                    <td>${escapeHtml(h.expires_at)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }

  async function handleCreateMaintenanceSubmit(e) {
    e.preventDefault();
    try {
      await apiFetch('/api/admin/maintenance', {
        method: 'POST',
        body: JSON.stringify({
          roomId: Number(document.getElementById('maintRoomId').value),
          startDate: document.getElementById('maintStartDate').value,
          endDate: document.getElementById('maintEndDate').value,
          reason: document.getElementById('maintReason').value
        })
      });
      await loadAdminTab('calendar');
      await performAvailabilitySearch();
    } catch (err) {
      alert(err.message);
    }
  }

  async function removeMaintenanceBlock(id) {
    try {
      await apiFetch(`/api/admin/maintenance/${id}`, { method: 'DELETE' });
      await loadAdminTab('calendar');
      await performAvailabilitySearch();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleImportIcalSubmit(e) {
    e.preventDefault();
    try {
      const roomId = Number(document.getElementById('icalRoomId').value);
      const res = await apiFetch(`/api/admin/rooms/${roomId}/ical-import`, {
        method: 'POST',
        body: JSON.stringify({
          channelName: document.getElementById('icalChannelName').value,
          icsContent: document.getElementById('icalContentInput').value
        })
      });
      alert(`Inbound iCal Sync Complete: ${res.importedCount} block(s) imported, ${res.skippedCount} skipped.`);
      await loadAdminTab('calendar');
      await performAvailabilitySearch();
    } catch (err) {
      alert(err.message);
    }
  }

  async function renderAdminSettingsTab(container) {
    const cfg = await apiFetch('/api/config');
    const s = cfg.settings;

    container.innerHTML = `
      <div class="checkout-columns">
        <div class="kpi-card">
          <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin-bottom:0.75rem;">Hotel Policies, Taxes, Dynamic Yield &amp; Environment Mode</h4>
          <form onsubmit="window.AureliaApp.handleSaveSettingsSubmit(event)">
            <div class="form-grid-2">
              <div class="form-group">
                <label>Environment Mode</label>
                <select id="setEnvMode">
                  <option value="staging" ${s.environment_mode === 'staging' ? 'selected' : ''}>Staging (Sample Inventory Labeled)</option>
                  <option value="production" ${s.environment_mode === 'production' ? 'selected' : ''}>Production (Live Verified Inventory)</option>
                </select>
              </div>
              <div class="form-group">
                <label>Same-Day Turnover Policy</label>
                <select id="setSameDayTurnover">
                  <option value="1" ${s.same_day_turnover ? 'selected' : ''}>Allowed (Arrival on Departure Day)</option>
                  <option value="0" ${!s.same_day_turnover ? 'selected' : ''}>Require 1-Night Buffer Between Stays</option>
                </select>
              </div>
            </div>
            <div class="form-grid-2">
              <div class="form-group">
                <label>Tax Rate (%)</label>
                <input type="number" step="0.1" id="setTaxRate" value="${s.tax_rate_percent}" required />
              </div>
              <div class="form-group">
                <label>Service Fee (%)</label>
                <input type="number" step="0.1" id="setServiceFee" value="${s.service_fee_percent}" required />
              </div>
            </div>
            <div class="form-grid-2">
              <div class="form-group">
                <label>City Levy Per Night ($)</label>
                <input type="number" step="0.5" id="setCityLevy" value="${s.city_levy_per_night}" required />
              </div>
              <div class="form-group">
                <label>Deposit Percentage (%)</label>
                <input type="number" step="1" id="setDepositPercent" value="${s.deposit_percent}" required />
              </div>
            </div>
            <div class="form-grid-2">
              <div class="form-group">
                <label>Checkout Hold Expiry (Minutes)</label>
                <input type="number" id="setHoldMins" value="${s.hold_duration_minutes}" required />
              </div>
              <div class="form-group">
                <label>Free Cancellation Window (Hours)</label>
                <input type="number" id="setCancelHours" value="${s.free_cancellation_hours}" required />
              </div>
            </div>

            <div style="border-top:1px solid #e2e8f0;padding-top:0.85rem;margin-top:0.5rem;margin-bottom:0.85rem;">
              <strong style="font-size:0.78rem;text-transform:uppercase;color:#1e293b;display:block;margin-bottom:0.5rem;">
                📈 Dynamic Occupancy-Based Yield Pricing Engine
              </strong>
              <div class="form-grid-3">
                <div class="form-group">
                  <label>Dynamic Yield Mode</label>
                  <select id="setDynamicYieldEnabled">
                    <option value="1" ${s.dynamic_yield_enabled !== 0 ? 'selected' : ''}>Enabled (Auto Surge)</option>
                    <option value="0" ${s.dynamic_yield_enabled === 0 ? 'selected' : ''}>Disabled</option>
                  </select>
                </div>
                <div class="form-group">
                  <label>Occupancy Threshold (%)</label>
                  <input type="number" step="1" id="setYieldThreshold" value="${s.high_demand_occupancy_threshold || 70}" required />
                </div>
                <div class="form-group">
                  <label>High-Demand Multiplier (×)</label>
                  <input type="number" step="0.05" id="setYieldMultiplier" value="${s.high_demand_multiplier || 1.15}" required />
                </div>
              </div>
            </div>

            <button type="submit" class="btn-primary" style="width:100%;">Save Hotel Policies, Yield Engine &amp; Financial Settings</button>
          </form>
        </div>

        <div>
          <!-- SeasonalRatesManagerUI -->
          <div class="kpi-card" style="margin-bottom:1.25rem;">
            <h4 style="font-family:var(--font-serif);font-size:1.3rem;margin-bottom:0.75rem;">Active Seasonal Rate Multipliers</h4>
            <ul style="padding-left:1.2rem;font-size:0.84rem;margin-bottom:0.85rem;">
              ${(cfg.seasonalRates || []).map((sr) => `
                <li style="margin-bottom:0.35rem;display:flex;justify-content:space-between;align-items:center;">
                  <span><strong>${escapeHtml(sr.name)}</strong>: ${escapeHtml(sr.start_date)} to ${escapeHtml(sr.end_date)} (×${sr.multiplier})</span>
                  <button type="button" class="nearby-date-btn" onclick="window.AureliaApp.deleteSeasonalRateUI(${sr.id})">Delete</button>
                </li>
              `).join('')}
            </ul>
            <form onsubmit="window.AureliaApp.handleCreateSeasonalRateSubmit(event)" class="form-grid-2" style="border-top:1px solid #e2e8f0;padding-top:0.75rem;">
              <div class="form-group">
                <label>Season Name</label>
                <input type="text" id="srName" placeholder="Monaco Yacht Show Week" required />
              </div>
              <div class="form-group">
                <label>Rate Multiplier (×)</label>
                <input type="number" step="0.05" id="srMultiplier" value="1.30" required />
              </div>
              <div class="form-group">
                <label>Start Date</label>
                <input type="date" id="srStart" value="${addDaysStr(todayStr(), 30)}" required />
              </div>
              <div class="form-group">
                <label>End Date</label>
                <input type="date" id="srEnd" value="${addDaysStr(todayStr(), 40)}" required />
              </div>
              <div class="form-group" style="grid-column:span 2;">
                <button type="submit" class="btn-outline-dark" style="width:100%;">+ Add Seasonal Rate Rule</button>
              </div>
            </form>
          </div>

          <!-- PromoCodesManagerUI -->
          <div class="kpi-card">
            <h4 style="font-family:var(--font-serif);font-size:1.3rem;margin-bottom:0.75rem;">Configured Promotional Codes</h4>
            <ul style="padding-left:1.2rem;font-size:0.84rem;margin-bottom:0.85rem;">
              ${(cfg.promoCodes || []).map((pc) => `
                <li style="margin-bottom:0.35rem;display:flex;justify-content:space-between;align-items:center;">
                  <span><code>${escapeHtml(pc.code)}</code> — ${escapeHtml(pc.description)} (${pc.discount_type === 'percent' ? pc.discount_value + '%' : '$' + pc.discount_value}, min ${pc.min_nights || 1}n)</span>
                  ${pc.id ? `<button type="button" class="nearby-date-btn" onclick="window.AureliaApp.deletePromoCodeUI(${pc.id})">Delete</button>` : ''}
                </li>
              `).join('')}
            </ul>
            <form onsubmit="window.AureliaApp.handleCreatePromoCodeSubmit(event)" class="form-grid-2" style="border-top:1px solid #e2e8f0;padding-top:0.75rem;">
              <div class="form-group">
                <label>Promo Code</label>
                <input type="text" id="pcCode" placeholder="GALA25" required />
              </div>
              <div class="form-group">
                <label>Discount Type &amp; Value</label>
                <div style="display:flex;gap:0.35rem;">
                  <select id="pcType" style="width:55%;">
                    <option value="percent">% Percent</option>
                    <option value="fixed">$ Fixed USD</option>
                  </select>
                  <input type="number" step="1" id="pcValue" value="15" required />
                </div>
              </div>
              <div class="form-group">
                <label>Description</label>
                <input type="text" id="pcDesc" placeholder="15% Gala Season Privilege" required />
              </div>
              <div class="form-group">
                <label>Min Nights</label>
                <input type="number" id="pcMinNights" value="2" min="1" required />
              </div>
              <div class="form-group" style="grid-column:span 2;">
                <button type="submit" class="btn-outline-dark" style="width:100%;">+ Create Promotional Code</button>
              </div>
            </form>
          </div>
        </div>
      </div>
    `;
  }

  async function handleSaveSettingsSubmit(e) {
    e.preventDefault();
    try {
      const res = await apiFetch('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({
          environmentMode: document.getElementById('setEnvMode').value,
          sameDayTurnover: document.getElementById('setSameDayTurnover').value === '1',
          taxRatePercent: Number(document.getElementById('setTaxRate').value),
          serviceFeePercent: Number(document.getElementById('setServiceFee').value),
          cityLevyPerNight: Number(document.getElementById('setCityLevy').value),
          depositPercent: Number(document.getElementById('setDepositPercent').value),
          holdDurationMinutes: Number(document.getElementById('setHoldMins').value),
          freeCancellationHours: Number(document.getElementById('setCancelHours').value),
          dynamicYieldEnabled: document.getElementById('setDynamicYieldEnabled').value === '1',
          highDemandOccupancyThreshold: Number(document.getElementById('setYieldThreshold').value),
          highDemandMultiplier: Number(document.getElementById('setYieldMultiplier').value)
        })
      });
      state.settings = res.settings;
      updateEnvironmentBanner();
      await performAvailabilitySearch();
      await loadAdminTab('settings');
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleCreateSeasonalRateSubmit(e) {
    e.preventDefault();
    try {
      await apiFetch('/api/admin/seasonal-rates', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('srName').value,
          multiplier: Number(document.getElementById('srMultiplier').value),
          startDate: document.getElementById('srStart').value,
          endDate: document.getElementById('srEnd').value
        })
      });
      await loadAdminTab('settings');
      await performAvailabilitySearch();
    } catch (err) {
      alert(err.message);
    }
  }

  async function deleteSeasonalRateUI(id) {
    try {
      await apiFetch(`/api/admin/seasonal-rates/${id}`, { method: 'DELETE' });
      await loadAdminTab('settings');
      await performAvailabilitySearch();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleCreatePromoCodeSubmit(e) {
    e.preventDefault();
    try {
      await apiFetch('/api/admin/promo-codes', {
        method: 'POST',
        body: JSON.stringify({
          code: document.getElementById('pcCode').value,
          discountType: document.getElementById('pcType').value,
          discountValue: Number(document.getElementById('pcValue').value),
          description: document.getElementById('pcDesc').value,
          minNights: Number(document.getElementById('pcMinNights').value)
        })
      });
      await loadAdminTab('settings');
    } catch (err) {
      alert(err.message);
    }
  }

  async function deletePromoCodeUI(id) {
    try {
      await apiFetch(`/api/admin/promo-codes/${id}`, { method: 'DELETE' });
      await loadAdminTab('settings');
    } catch (err) {
      alert(err.message);
    }
  }

  async function renderAdminAuditTab(container) {
    const [auditData, usersData, tplData, integrationsData] = await Promise.all([
      apiFetch('/api/admin/audit-logs?limit=40'),
      apiFetch('/api/admin/users').catch(() => ({ users: [] })),
      apiFetch('/api/admin/templates').catch(() => ({ templates: [] })),
      apiFetch('/api/admin/integrations').catch(() => ({ integrations: null }))
    ]);

    container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem;flex-wrap:wrap;gap:0.75rem;">
        <div>
          <h4 style="font-family:var(--font-serif);font-size:1.35rem;">Immutable Audit Trail, RBAC, Templates &amp; Cloud Gateways</h4>
          <p style="font-size:0.82rem;color:#64748b;">Every reservation, checkout hold, cancellation, payment, refund, and admin change is logged.</p>
        </div>
        <button type="button" class="btn-primary" onclick="window.AureliaApp.triggerAdminDatabaseBackup()">
          💾 Trigger Immediate SQLite Hot Backup Snapshot
        </button>
      </div>

      <div id="backupStatusAlert" class="availability-box is-available hidden"></div>

      <!-- ExternalCloudNotificationAndGatewayAdapters UI -->
      ${integrationsData && integrationsData.paymentGateways ? `
        <div class="kpi-card" style="margin-bottom:1.5rem;">
          <h5 style="font-family:var(--font-serif);font-size:1.2rem;margin-bottom:0.5rem;">External Cloud Payment &amp; Messaging Adapter Status</h5>
          <div class="data-table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Adapter Mode</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                ${[...(integrationsData.paymentGateways || []), ...(integrationsData.messagingAdapters || [])].map((ad) => `
                  <tr>
                    <td><strong>${escapeHtml(ad.name)}</strong></td>
                    <td><span class="status-pill ${ad.configured ? 'confirmed' : 'checked_in'}">${escapeHtml(ad.mode)}</span></td>
                    <td><code>${escapeHtml(ad.status)}</code></td>
                    <td>
                      <button type="button" class="nearby-date-btn" onclick="window.AureliaApp.verifyCloudAdapterHandshake('${escapeHtml(ad.id)}')">
                        Verify Handshake
                      </button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      ` : ''}

      <!-- StaffRoleManagementUI -->
      ${usersData.users && usersData.users.length > 0 ? `
        <h5 style="font-family:var(--font-serif);font-size:1.2rem;margin-bottom:0.5rem;">Staff &amp; Guest RBAC Directory (Role Management)</h5>
        <div class="data-table-wrapper" style="margin-bottom:1.75rem;">
          <table class="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role (RBAC)</th>
                <th>Loyalty Tier</th>
                <th>Update Access</th>
              </tr>
            </thead>
            <tbody>
              ${usersData.users.map((u) => `
                <tr>
                  <td><strong>${escapeHtml(u.first_name)} ${escapeHtml(u.last_name)}</strong></td>
                  <td>${escapeHtml(u.email)}</td>
                  <td>
                    <select id="userRole_${u.id}" style="padding:0.25rem;font-size:0.78rem;">
                      ${['guest', 'receptionist', 'finance', 'manager', 'admin'].map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}
                    </select>
                  </td>
                  <td>${escapeHtml(u.loyalty_tier)} (${u.loyalty_points} pts)</td>
                  <td>
                    <button type="button" class="nearby-date-btn" onclick="window.AureliaApp.updateStaffRoleUI(${u.id})">Save Role</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : ''}

      <!-- NotificationTemplatesEditorUI -->
      ${tplData.templates && tplData.templates.length > 0 ? `
        <div class="kpi-card" style="margin-bottom:1.75rem;">
          <h5 style="font-family:var(--font-serif);font-size:1.2rem;margin-bottom:0.65rem;">Transactional Notification Templates Editor</h5>
          <div class="checkout-columns">
            ${tplData.templates.map((t) => `
              <form onsubmit="window.AureliaApp.saveNotificationTemplateUI(event, '${escapeHtml(t.code)}')" style="background:#f8fafc;padding:0.85rem;border:1px solid #e2e8f0;border-radius:6px;">
                <div style="font-size:0.75rem;font-weight:700;color:#475569;margin-bottom:0.35rem;"><code>${escapeHtml(t.code)}</code> (${escapeHtml(t.channel)})</div>
                <div class="form-group">
                  <label>Subject Template</label>
                  <input type="text" id="tplSubj_${escapeHtml(t.code)}" value="${escapeHtml(t.subject_template)}" required />
                </div>
                <div class="form-group">
                  <label>Body Template</label>
                  <textarea id="tplBody_${escapeHtml(t.code)}" rows="3" required>${escapeHtml(t.body_template)}</textarea>
                </div>
                <button type="submit" class="btn-outline-dark" style="padding:0.35rem 0.75rem;font-size:0.74rem;">Save Template</button>
              </form>
            `).join('')}
          </div>
        </div>
      ` : ''}

      <h5 style="font-family:var(--font-serif);font-size:1.2rem;margin-bottom:0.5rem;">Recent Security &amp; Transaction Audit Events</h5>
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Timestamp (UTC)</th>
              <th>Event Type</th>
              <th>Entity</th>
              <th>Actor Role</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            ${(auditData.auditLogs || []).map((log) => `
              <tr>
                <td style="white-space:nowrap;font-family:monospace;font-size:0.75rem;">${escapeHtml(log.created_at)}</td>
                <td><code>${escapeHtml(log.event_type)}</code></td>
                <td>${escapeHtml(log.entity_type)} (${escapeHtml(log.entity_id)})</td>
                <td>${escapeHtml(log.actor_role)}</td>
                <td>${escapeHtml(log.summary)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  async function updateStaffRoleUI(userId) {
    try {
      const role = document.getElementById(`userRole_${userId}`).value;
      await apiFetch(`/api/admin/users/${userId}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role, isActive: true })
      });
      await loadAdminTab('audit');
    } catch (err) {
      alert(err.message);
    }
  }

  async function saveNotificationTemplateUI(e, code) {
    e.preventDefault();
    try {
      await apiFetch(`/api/admin/templates/${encodeURIComponent(code)}`, {
        method: 'PUT',
        body: JSON.stringify({
          subjectTemplate: document.getElementById(`tplSubj_${code}`).value,
          bodyTemplate: document.getElementById(`tplBody_${code}`).value
        })
      });
      await loadAdminTab('audit');
    } catch (err) {
      alert(err.message);
    }
  }

  async function verifyCloudAdapterHandshake(adapterId) {
    try {
      const res = await apiFetch('/api/admin/integrations/test', {
        method: 'POST',
        body: JSON.stringify({ adapterId })
      });
      alert(`${res.adapterName} (${res.mode}) — ${res.status.toUpperCase()} (${res.traceId})\nLatency: ${res.latencyMs}ms`);
    } catch (err) {
      alert(err.message);
    }
  }

  async function renderAdminUsersTab(container) {
    const [usersData, concData, payData] = await Promise.all([
      apiFetch('/api/admin/users').catch(() => ({ users: [] })),
      apiFetch('/api/admin/concierge-requests').catch(() => ({ conciergeRequests: [] })),
      apiFetch('/api/admin/payments').catch(() => ({ payments: [] }))
    ]);

    const users = usersData.users || [];
    const requests = concData.conciergeRequests || [];
    const payments = payData.payments || [];

    const totalGuests = users.filter((u) => u.role === 'guest').length;
    const totalStaff = users.filter((u) => u.role !== 'guest').length;
    const totalPoints = users.reduce((sum, u) => sum + Number(u.loyalty_points || 0), 0);
    const pendingConcierge = requests.filter((r) => r.status === 'pending' || r.status === 'in_progress').length;

    container.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">Registered Accounts</div>
          <div class="kpi-value">${users.length}</div>
          <div style="font-size:0.75rem;color:#64748b;">${totalGuests} VIP Guests • ${totalStaff} Staff Members</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Active Loyalty Pool</div>
          <div class="kpi-value" style="color:var(--gold-primary);">${totalPoints.toLocaleString()} pts</div>
          <div style="font-size:0.75rem;color:#64748b;">$${Math.floor(totalPoints / 10).toLocaleString()} USD redeemable value</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">VIP Concierge Queue</div>
          <div class="kpi-value">${pendingConcierge}</div>
          <div style="font-size:0.75rem;color:#64748b;">${requests.length} total concierge requests</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Payment Transactions</div>
          <div class="kpi-value" style="color:var(--emerald-ok);">${payments.length}</div>
          <div style="font-size:0.75rem;color:#64748b;">Tokenised Cards, Wires &amp; Refunds</div>
        </div>
      </div>

      <!-- Create New User / Staff Account -->
      <div class="kpi-card" style="margin-bottom:1.75rem;">
        <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin-bottom:0.65rem;">Create New User or Staff Account (Full RBAC &amp; Loyalty Provisioning)</h4>
        <form onsubmit="window.AureliaApp.handleAdminCreateUserSubmit(event)" class="search-grid">
          <div class="search-field">
            <label>First Name *</label>
            <input type="text" id="admNewFirst" placeholder="Lord Julian" required />
          </div>
          <div class="search-field">
            <label>Last Name *</label>
            <input type="text" id="admNewLast" placeholder="Vance" required />
          </div>
          <div class="search-field">
            <label>Email Address *</label>
            <input type="email" id="admNewEmail" placeholder="julian.vance@example.com" required />
          </div>
          <div class="search-field">
            <label>Role (RBAC)</label>
            <select id="admNewRole">
              <option value="guest">guest (VIP Member)</option>
              <option value="receptionist">receptionist (Front Desk)</option>
              <option value="finance">finance (Folio &amp; Refunds)</option>
              <option value="manager">manager (Operations)</option>
              <option value="admin">admin (Full Access)</option>
            </select>
          </div>
          <div class="search-field">
            <label>Loyalty Tier</label>
            <select id="admNewTier">
              <option value="Aurélia Privé">Aurélia Privé</option>
              <option value="Gold Sanctuary">Gold Sanctuary</option>
              <option value="Imperial Black">Imperial Black</option>
            </select>
          </div>
          <div class="search-field">
            <label>Initial Loyalty Points</label>
            <input type="number" id="admNewPoints" value="2500" min="0" required />
          </div>
          <div class="search-field">
            <label>Password *</label>
            <input type="password" id="admNewPass" value="AureliaVIP!2026" minlength="8" required />
          </div>
          <div class="search-field">
            <button type="submit" class="btn-primary" style="width:100%;">+ Create Account</button>
          </div>
        </form>
      </div>

      <!-- Full User & Staff Directory with Inline Editing -->
      <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin-bottom:0.65rem;">Users &amp; Staff Directory — Inline Role, Tier, Loyalty Points &amp; Status Management (${users.length})</h4>
      <div class="data-table-wrapper" style="margin-bottom:2rem;">
        <table class="data-table">
          <thead>
            <tr>
              <th>ID &amp; Name</th>
              <th>Email &amp; Country</th>
              <th>Stays &amp; Spend</th>
              <th>RBAC Role</th>
              <th>Loyalty Tier</th>
              <th>Loyalty Points</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${users.map((u) => `
              <tr>
                <td><strong>#${u.id} ${escapeHtml(u.first_name)} ${escapeHtml(u.last_name)}</strong></td>
                <td>
                  ${escapeHtml(u.email)}<br/>
                  <span style="font-size:0.74rem;color:#64748b;">${escapeHtml(u.phone || '')} • ${escapeHtml(u.country || 'Switzerland')}</span>
                </td>
                <td>
                  <strong>${u.total_bookings || 0} stay(s)</strong><br/>
                  <span style="font-size:0.75rem;color:var(--emerald-ok);">$${Number(u.lifetime_spend_usd || 0).toLocaleString()} USD</span>
                </td>
                <td>
                  <select id="admUserRole_${u.id}" style="padding:0.25rem;font-size:0.78rem;">
                    ${['guest', 'receptionist', 'finance', 'manager', 'admin'].map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}
                  </select>
                </td>
                <td>
                  <select id="admUserTier_${u.id}" style="padding:0.25rem;font-size:0.78rem;">
                    ${['Aurélia Privé', 'Gold Sanctuary', 'Imperial Black'].map((t) => `<option value="${t}" ${u.loyalty_tier === t ? 'selected' : ''}>${t}</option>`).join('')}
                  </select>
                </td>
                <td>
                  <input type="number" id="admUserPts_${u.id}" value="${u.loyalty_points}" style="width:90px;padding:0.25rem;font-size:0.78rem;" />
                </td>
                <td>
                  <select id="admUserActive_${u.id}" style="padding:0.25rem;font-size:0.78rem;">
                    <option value="1" ${u.is_active ? 'selected' : ''}>Active</option>
                    <option value="0" ${!u.is_active ? 'selected' : ''}>Suspended</option>
                  </select>
                </td>
                <td>
                  <div style="display:flex;gap:0.35rem;">
                    <button type="button" class="nearby-date-btn" style="border-color:var(--emerald-ok);color:var(--emerald-ok);" onclick="window.AureliaApp.handleAdminSaveUserRow(${u.id})">Save</button>
                    ${state.currentUser && state.currentUser.id !== u.id ? `
                      <button type="button" class="nearby-date-btn" onclick="window.AureliaApp.handleAdminDeleteUser(${u.id})">Delete</button>
                    ` : ''}
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <!-- VIP Guest Concierge Service Desk Queue -->
      <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin-bottom:0.65rem;">VIP Guest Concierge Service Desk Queue (${requests.length})</h4>
      <div class="data-table-wrapper" style="margin-bottom:2rem;">
        <table class="data-table">
          <thead>
            <tr>
              <th>Ref &amp; Priority</th>
              <th>Guest &amp; Booking</th>
              <th>Department &amp; Subject</th>
              <th>Status</th>
              <th>Concierge Response Note to Guest</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${requests.length === 0 ? '<tr><td colspan="6">No guest concierge service requests submitted yet.</td></tr>' : requests.map((cr) => `
              <tr>
                <td>
                  <code>${escapeHtml(cr.request_reference)}</code><br/>
                  <span class="status-pill ${cr.priority === 'vip_urgent' ? 'cancelled' : 'checked_in'}">${escapeHtml(cr.priority)}</span>
                </td>
                <td>
                  <strong>${escapeHtml(cr.guest_name)}</strong><br/>
                  <span style="font-size:0.74rem;color:#64748b;">${escapeHtml(cr.guest_email)} ${cr.booking_reference ? `• <code>${escapeHtml(cr.booking_reference)}</code>` : ''}</span>
                </td>
                <td>
                  <strong>${escapeHtml(cr.subject)}</strong><br/>
                  <span style="font-size:0.75rem;color:#475569;">${escapeHtml(cr.category)} • ${escapeHtml(cr.details)}</span>
                </td>
                <td>
                  <select id="admConcStatus_${cr.id}" style="padding:0.25rem;font-size:0.78rem;">
                    ${['pending', 'in_progress', 'fulfilled', 'cancelled'].map((st) => `<option value="${st}" ${cr.status === st ? 'selected' : ''}>${st}</option>`).join('')}
                  </select>
                </td>
                <td>
                  <input type="text" id="admConcNotes_${cr.id}" value="${escapeHtml(cr.staff_notes || 'Arranged by Head Concierge Desk')}" style="width:100%;padding:0.25rem;font-size:0.78rem;" />
                </td>
                <td>
                  <button type="button" class="nearby-date-btn" style="border-color:var(--emerald-ok);color:var(--emerald-ok);" onclick="window.AureliaApp.handleAdminUpdateConciergeRequest(${cr.id})">
                    Update &amp; Notify
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <!-- Financial Payment & Refund Transactions Ledger -->
      <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin-bottom:0.65rem;">Financial Payment &amp; Refund Transactions Ledger (${payments.length})</h4>
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Payment Ref &amp; Invoice</th>
              <th>Booking Ref</th>
              <th>Guest</th>
              <th>Method &amp; Type</th>
              <th>Amount (USD)</th>
              <th>Status &amp; Timestamp</th>
            </tr>
          </thead>
          <tbody>
            ${payments.length === 0 ? '<tr><td colspan="6">No payment transactions recorded yet.</td></tr>' : payments.map((p) => `
              <tr>
                <td>
                  <code>${escapeHtml(p.payment_reference)}</code><br/>
                  <span style="font-size:0.74rem;color:#64748b;">${escapeHtml(p.invoice_number)}</span>
                </td>
                <td><code>${escapeHtml(p.booking_reference)}</code></td>
                <td>${escapeHtml(p.guest_first_name || '')} ${escapeHtml(p.guest_last_name || '')}</td>
                <td>${escapeHtml(p.payment_method.toUpperCase())} (${escapeHtml(p.payment_type)})</td>
                <td><strong style="color:${p.amount < 0 ? 'var(--crimson-err)' : 'var(--emerald-ok)'};">$${Number(p.amount).toFixed(2)} USD</strong></td>
                <td>
                  <span class="status-pill ${escapeHtml(p.status)}">${escapeHtml(p.status)}</span>
                  <div style="font-size:0.72rem;color:#64748b;margin-top:0.15rem;">${escapeHtml(p.created_at)}</div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  async function handleAdminCreateUserSubmit(e) {
    e.preventDefault();
    try {
      await apiFetch('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          firstName: document.getElementById('admNewFirst').value,
          lastName: document.getElementById('admNewLast').value,
          email: document.getElementById('admNewEmail').value,
          role: document.getElementById('admNewRole').value,
          loyaltyTier: document.getElementById('admNewTier').value,
          loyaltyPoints: Number(document.getElementById('admNewPoints').value),
          password: document.getElementById('admNewPass').value
        })
      });
      await loadAdminTab('users');
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleAdminSaveUserRow(userId) {
    try {
      await apiFetch(`/api/admin/users/${userId}`, {
        method: 'PUT',
        body: JSON.stringify({
          role: document.getElementById(`admUserRole_${userId}`).value,
          loyaltyTier: document.getElementById(`admUserTier_${userId}`).value,
          loyaltyPoints: Number(document.getElementById(`admUserPts_${userId}`).value),
          isActive: document.getElementById(`admUserActive_${userId}`).value === '1'
        })
      });
      await loadAdminTab('users');
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleAdminDeleteUser(userId) {
    try {
      await apiFetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
      await loadAdminTab('users');
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleAdminUpdateConciergeRequest(id) {
    try {
      await apiFetch(`/api/admin/concierge-requests/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: document.getElementById(`admConcStatus_${id}`).value,
          staffNotes: document.getElementById(`admConcNotes_${id}`).value
        })
      });
      await loadAdminTab('users');
    } catch (err) {
      alert(err.message);
    }
  }

  async function triggerAdminDatabaseBackup() {
    try {
      const res = await apiFetch('/api/admin/backup', { method: 'POST' });
      const alertEl = document.getElementById('backupStatusAlert');
      if (alertEl) {
        alertEl.classList.remove('hidden');
        alertEl.innerHTML = `
          <div class="availability-box-heading">✓ Hot Backup Snapshot Completed</div>
          <p>File: <code>${escapeHtml(res.backup.backupPath)}</code> (${res.backup.sizeBytes.toLocaleString()} bytes) at ${escapeHtml(res.backup.createdAt)}</p>
        `;
      }
    } catch (err) {
      alert(err.message);
    }
  }

  let activeAdminThreadId = null;
  let adminInboxStatusFilter = 'all';
  let adminInboxSearchQuery = '';

  async function openMessagingInboxDirect() {
    if (state.currentUser && ['admin', 'manager', 'receptionist', 'finance'].includes(state.currentUser.role)) {
      switchView('admin');
      await switchAdminTab('messages');
      return;
    }
    if (!state.currentUser) {
      await quickGuestLogin('elena.rostova@example.com', 'GuestPass!2026');
    }
    switchView('portal');
    await switchGuestTab('messages');
  }

  async function switchToAdminMessagingInbox() {
    await quickStaffLogin('admin@maisonaurelia.luxury', 'AureliaAdmin!2026');
    switchView('admin');
    await switchAdminTab('messages');
  }

  async function switchToGuestMessagingInbox() {
    await quickGuestLogin('elena.rostova@example.com', 'GuestPass!2026');
    switchView('portal');
    await switchGuestTab('messages');
  }

  async function markAllGuestMessagesRead() {
    try {
      await apiFetch('/api/guest/messages/mark-all-read', { method: 'POST' });
      await renderGuestPortal();
    } catch (err) {
      alert(err.message);
    }
  }

  async function markAllAdminMessagesRead() {
    try {
      await apiFetch('/api/admin/messages/mark-all-read', { method: 'POST' });
      await loadAdminTab('messages');
    } catch (err) {
      alert(err.message);
    }
  }

  async function filterAdminInbox(status, search) {
    if (status !== undefined && status !== null) adminInboxStatusFilter = status;
    if (search !== undefined && search !== null) adminInboxSearchQuery = search;
    await loadAdminTab('messages');
  }

  function fillAdminQuickReply(templateText) {
    const el = document.getElementById('admReplyBodyInput');
    if (el) el.value = templateText;
  }

  async function handleAdminDeleteMessageThread(threadId) {
    try {
      await apiFetch(`/api/admin/messages/${threadId}`, { method: 'DELETE' });
      if (activeAdminThreadId === Number(threadId)) {
        activeAdminThreadId = null;
      }
      await loadAdminTab('messages');
    } catch (err) {
      alert(err.message);
    }
  }

  async function renderAdminMessagesTab(container) {
    const qs = new URLSearchParams();
    if (adminInboxStatusFilter && adminInboxStatusFilter !== 'all') qs.set('status', adminInboxStatusFilter);
    if (adminInboxSearchQuery) qs.set('search', adminInboxSearchQuery);
    const inboxData = await apiFetch(`/api/admin/messages${qs.toString() ? '?' + qs.toString() : ''}`);
    const threads = inboxData.threads || [];
    const m = inboxData.metrics || {
      totalThreads: threads.length,
      unreadThreadsCount: 0,
      awaitingStaffCount: 0,
      resolvedCount: 0
    };

    if (!activeAdminThreadId && threads.length > 0) {
      activeAdminThreadId = threads[0].id;
    }

    let activeThreadDetail = null;
    if (activeAdminThreadId) {
      try {
        const detailRes = await apiFetch(`/api/admin/messages/${activeAdminThreadId}`);
        activeThreadDetail = detailRes.thread;
      } catch (_) {
        activeThreadDetail = null;
      }
    }

    container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;background:#0b132b;color:#f8fafc;padding:0.75rem 1.1rem;border-radius:6px;margin-bottom:1.25rem;flex-wrap:wrap;gap:0.75rem;border-left:4px solid #c5a059;">
        <div>
          <strong style="font-size:0.9rem;color:var(--gold-bright);">💬 Admin &amp; Concierge Messaging Command Center</strong>
          <span style="font-size:0.8rem;color:#cbd5e1;margin-left:0.5rem;">Inspect guest messages, send official replies, and manage conversation status.</span>
        </div>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
          <button type="button" class="staging-banner-action" onclick="window.AureliaApp.markAllAdminMessagesRead()">✓ Mark All Read</button>
          <button type="button" class="staging-banner-action" onclick="window.AureliaApp.switchToGuestMessagingInbox()">&larr; Switch to User Inbox as Guest</button>
        </div>
      </div>

      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">Total Conversation Threads</div>
          <div class="kpi-value">${m.totalThreads}</div>
          <div style="font-size:0.75rem;color:#64748b;">Direct Guest &harr; Admin / Concierge Inbox</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Unread Guest Messages</div>
          <div class="kpi-value" style="color:var(--crimson-err);">${m.unreadThreadsCount}</div>
          <div style="font-size:0.75rem;color:#64748b;">Threads with new unread guest messages</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Awaiting Staff Reply</div>
          <div class="kpi-value" style="color:var(--gold-primary);">${m.awaitingStaffCount}</div>
          <div style="font-size:0.75rem;color:#64748b;">Open / awaiting staff response</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Resolved / Closed</div>
          <div class="kpi-value" style="color:var(--emerald-ok);">${m.resolvedCount}</div>
          <div style="font-size:0.75rem;color:#64748b;">Completed guest inquiries</div>
        </div>
      </div>

      <div class="checkout-columns" style="align-items:start;">
        <div>
          <!-- Admin Thread Inbox List + Filter/Search -->
          <div class="kpi-card" style="margin-bottom:1.25rem;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.65rem;flex-wrap:wrap;gap:0.5rem;">
              <h4 style="font-family:var(--font-serif);font-size:1.3rem;">💬 Guest Messaging Threads (${threads.length})</h4>
              <select style="padding:0.3rem;font-size:0.78rem;" onchange="window.AureliaApp.filterAdminInbox(this.value, null)">
                <option value="all" ${adminInboxStatusFilter === 'all' ? 'selected' : ''}>All Threads</option>
                <option value="awaiting_staff" ${adminInboxStatusFilter === 'awaiting_staff' ? 'selected' : ''}>Awaiting Staff Reply</option>
                <option value="awaiting_guest" ${adminInboxStatusFilter === 'awaiting_guest' ? 'selected' : ''}>Awaiting Guest</option>
                <option value="resolved" ${adminInboxStatusFilter === 'resolved' ? 'selected' : ''}>Resolved</option>
              </select>
            </div>
            <div style="display:flex;gap:0.4rem;margin-bottom:0.75rem;">
              <input type="text" id="admInboxSearchInput" value="${escapeHtml(adminInboxSearchQuery)}" placeholder="Search by guest name, email, ref, or subject..." style="flex:1;padding:0.4rem 0.65rem;font-size:0.8rem;border:1px solid #cbd5e1;border-radius:4px;" />
              <button type="button" class="btn-secondary" style="padding:0.4rem 0.75rem;font-size:0.78rem;" onclick="window.AureliaApp.filterAdminInbox(null, document.getElementById('admInboxSearchInput').value)">Filter</button>
            </div>
            ${threads.length === 0 ? `<p style="font-size:0.84rem;color:#64748b;">No matching guest message threads.</p>` : threads.map((t) => `
              <div onclick="window.AureliaApp.selectAdminMessageThread(${t.id})" style="cursor:pointer;padding:0.75rem;border-radius:6px;margin-bottom:0.5rem;border:1px solid ${t.id === activeAdminThreadId ? 'var(--gold-primary)' : '#e2e8f0'};background:${t.id === activeAdminThreadId ? '#fffbeb' : '#ffffff'};">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;">
                  <strong style="font-size:0.85rem;"><code>${escapeHtml(t.thread_reference)}</code> — ${escapeHtml(t.subject)}</strong>
                  ${t.unread_by_admin > 0 ? `<span class="status-pill cancelled">UNREAD (${t.unread_by_admin})</span>` : `<span class="status-pill ${t.status === 'resolved' ? 'confirmed' : 'checked_in'}">${escapeHtml(t.status)}</span>`}
                </div>
                <div style="font-size:0.75rem;color:#64748b;margin-top:0.2rem;">
                  Guest: <strong>${escapeHtml(t.guest_name)}</strong> (${escapeHtml(t.guest_email)}) • ${escapeHtml(t.department)} ${t.booking_reference ? `• <code>${escapeHtml(t.booking_reference)}</code>` : ''}
                </div>
                <div style="font-size:0.78rem;color:#334155;margin-top:0.25rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  <strong>${escapeHtml(t.last_sender_name || '')}:</strong> ${escapeHtml(t.last_message_preview || '')}
                </div>
              </div>
            `).join('')}
          </div>

          <!-- Initiate New Direct Message to Guest -->
          <div class="kpi-card">
            <h4 style="font-family:var(--font-serif);font-size:1.25rem;margin-bottom:0.5rem;">Initiate New Direct Message to Guest</h4>
            <form onsubmit="window.AureliaApp.handleAdminStartNewThreadSubmit(event)">
              <div class="form-grid-2">
                <div class="form-group">
                  <label>Guest Email *</label>
                  <input type="email" id="admMsgEmail" value="elena.rostova@example.com" required />
                </div>
                <div class="form-group">
                  <label>Guest Name</label>
                  <input type="text" id="admMsgName" value="Elena Rostova" required />
                </div>
              </div>
              <div class="form-grid-2">
                <div class="form-group">
                  <label>Department</label>
                  <select id="admMsgDept">
                    <option value="Head Concierge & Admin">Head Concierge &amp; Admin</option>
                    <option value="Front Desk & Reservations">Front Desk &amp; Reservations</option>
                    <option value="Finance & Folio Billing">Finance &amp; Folio Billing</option>
                  </select>
                </div>
                <div class="form-group">
                  <label>Booking Ref (Optional)</label>
                  <input type="text" id="admMsgBookingRef" placeholder="AUR-2026-PRES01" />
                </div>
              </div>
              <div class="form-group">
                <label>Subject *</label>
                <input type="text" id="admMsgSubject" placeholder="Pre-Arrival Suite Welcome &amp; Chauffeur Confirmation" required />
              </div>
              <div class="form-group">
                <label>Message Body *</label>
                <textarea id="admMsgBody" rows="2" placeholder="Write direct message to guest..." required></textarea>
              </div>
              <button type="submit" class="btn-secondary" style="width:100%;">Dispatch Direct Message to Guest</button>
            </form>
          </div>
        </div>

        <!-- Admin Thread Reader & Reply Console -->
        <div class="kpi-card">
          ${!activeThreadDetail ? `
            <div style="text-align:center;padding:2.5rem;color:#64748b;">
              <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin-bottom:0.4rem;">Select a Guest Conversation Thread</h4>
              <p style="font-size:0.85rem;">Click any thread on the left to inspect the conversation and send an official Admin / Concierge reply.</p>
            </div>
          ` : `
            <div style="border-bottom:1px solid #e2e8f0;padding-bottom:0.85rem;margin-bottom:1rem;">
              <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;">
                <div>
                  <span class="staging-badge">${escapeHtml(activeThreadDetail.thread_reference)} • ${escapeHtml(activeThreadDetail.department)}</span>
                  <span class="status-pill ${activeThreadDetail.priority === 'vip_urgent' ? 'cancelled' : 'checked_in'}" style="margin-left:0.35rem;">${escapeHtml(activeThreadDetail.priority)}</span>
                </div>
                <div style="display:flex;gap:0.4rem;align-items:center;">
                  <label style="font-size:0.75rem;color:#64748b;">Thread Status:</label>
                  <select id="admThreadStatusSelect" style="padding:0.25rem;font-size:0.78rem;" onchange="window.AureliaApp.handleAdminUpdateThreadStatus(${activeThreadDetail.id}, this.value)">
                    ${['awaiting_staff', 'awaiting_guest', 'resolved', 'closed'].map((st) => `<option value="${st}" ${activeThreadDetail.status === st ? 'selected' : ''}>${st}</option>`).join('')}
                  </select>
                  <button type="button" class="nearby-date-btn" onclick="window.AureliaApp.handleAdminDeleteMessageThread(${activeThreadDetail.id})">Delete</button>
                </div>
              </div>
              <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin-top:0.35rem;">${escapeHtml(activeThreadDetail.subject)}</h4>
              <div style="font-size:0.8rem;color:#475569;margin-top:0.2rem;">
                Guest: <strong>${escapeHtml(activeThreadDetail.guest_name)}</strong> (<code>${escapeHtml(activeThreadDetail.guest_email)}</code>)
                ${activeThreadDetail.booking_reference ? ` • Booking: <code>${escapeHtml(activeThreadDetail.booking_reference)}</code>` : ''}
              </div>
            </div>

            <div style="max-height:380px;overflow-y:auto;padding-right:0.25rem;margin-bottom:1rem;">
              ${(activeThreadDetail.messages || []).map((msg) => {
                const isStaff = msg.sender_role !== 'guest';
                return `
                  <div style="margin-bottom:0.75rem;display:flex;flex-direction:column;align-items:${isStaff ? 'flex-end' : 'flex-start'};">
                    <div style="max-width:86%;padding:0.75rem 0.95rem;border-radius:10px;background:${isStaff ? '#0b132b' : '#f8fafc'};color:${isStaff ? '#f8fafc' : '#0f172a'};border:1px solid ${isStaff ? '#1e293b' : '#cbd5e1'};font-size:0.84rem;">
                      <div style="display:flex;justify-content:space-between;gap:1rem;font-size:0.72rem;margin-bottom:0.3rem;color:${isStaff ? '#d4af63' : '#475569'};font-weight:700;">
                        <span>${escapeHtml(msg.sender_name)} (${escapeHtml(msg.sender_role.toUpperCase())})</span>
                        <span>${escapeHtml(msg.created_at)}</span>
                      </div>
                      <div style="white-space:pre-wrap;line-height:1.5;">${escapeHtml(msg.body)}</div>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>

            <form onsubmit="window.AureliaApp.handleAdminReplyMessageSubmit(event, ${activeThreadDetail.id})" style="border-top:1px solid #e2e8f0;padding-top:0.85rem;">
              <div style="margin-bottom:0.5rem;display:flex;gap:0.35rem;flex-wrap:wrap;align-items:center;">
                <span style="font-size:0.74rem;font-weight:700;color:#64748b;">Quick Replies:</span>
                <button type="button" class="nearby-date-btn" onclick="window.AureliaApp.fillAdminQuickReply('It is our pleasure to confirm your arrangement. Our Head Butler and Concierge Desk have scheduled everything according to your preferences.')">✓ Confirm Arrangement</button>
                <button type="button" class="nearby-date-btn" onclick="window.AureliaApp.fillAdminQuickReply('Your corner table by the fountain at Le Jardin d’Or is reserved for 20:00, and our Head Sommelier awaits your arrival.')">🍽️ Michelin Table Reserved</button>
                <button type="button" class="nearby-date-btn" onclick="window.AureliaApp.fillAdminQuickReply('Our Rolls-Royce Phantom VIII chauffeur and rooftop helipad team are confirmed and standing by for your arrival.')">🚁 Chauffeur / Helipad Ready</button>
              </div>
              <div class="form-group" style="margin-bottom:0.65rem;">
                <label>Official Admin / Concierge Reply to ${escapeHtml(activeThreadDetail.guest_name)} *</label>
                <textarea id="admReplyBodyInput" rows="3" placeholder="Type your reply to the guest..." required></textarea>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:center;gap:0.75rem;flex-wrap:wrap;">
                <div style="display:flex;align-items:center;gap:0.4rem;font-size:0.8rem;">
                  <label>Set status after reply:</label>
                  <select id="admReplyNextStatus" style="padding:0.35rem;">
                    <option value="awaiting_guest">awaiting_guest</option>
                    <option value="resolved">resolved</option>
                  </select>
                </div>
                <button type="submit" class="btn-primary">Send Reply &amp; Notify User</button>
              </div>
            </form>
          `}
        </div>
      </div>
    `;
  }

  async function selectAdminMessageThread(threadId) {
    activeAdminThreadId = Number(threadId);
    await loadAdminTab('messages');
  }

  async function handleAdminStartNewThreadSubmit(e) {
    e.preventDefault();
    try {
      const res = await apiFetch('/api/admin/messages', {
        method: 'POST',
        body: JSON.stringify({
          guestEmail: document.getElementById('admMsgEmail').value,
          guestName: document.getElementById('admMsgName').value,
          department: document.getElementById('admMsgDept').value,
          bookingReference: document.getElementById('admMsgBookingRef').value,
          subject: document.getElementById('admMsgSubject').value,
          message: document.getElementById('admMsgBody').value
        })
      });
      activeAdminThreadId = res.thread.id;
      await loadAdminTab('messages');
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleAdminReplyMessageSubmit(e, threadId) {
    e.preventDefault();
    try {
      await apiFetch(`/api/admin/messages/${threadId}/reply`, {
        method: 'POST',
        body: JSON.stringify({
          body: document.getElementById('admReplyBodyInput').value,
          status: document.getElementById('admReplyNextStatus').value
        })
      });
      activeAdminThreadId = Number(threadId);
      await loadAdminTab('messages');
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleAdminUpdateThreadStatus(threadId, status) {
    try {
      await apiFetch(`/api/admin/messages/${threadId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status })
      });
      await loadAdminTab('messages');
    } catch (err) {
      alert(err.message);
    }
  }

  // -------------------------------------------------------------------------
  // Customer Reviews & Verified Stay Testimonials Page (#view-reviews)
  // -------------------------------------------------------------------------

  async function renderReviewsPage() {
    const nameEl = document.getElementById('reviewGuestName');
    const emailEl = document.getElementById('reviewGuestEmail');
    const countryEl = document.getElementById('reviewGuestCountry');

    if (state.currentUser) {
      if (nameEl && !nameEl.value) {
        nameEl.value = `${state.currentUser.first_name || ''} ${state.currentUser.last_name || ''}`.trim();
      }
      if (emailEl && !emailEl.value) {
        emailEl.value = state.currentUser.email || '';
      }
      if (countryEl && !countryEl.value && state.currentUser.country) {
        countryEl.value = state.currentUser.country;
      }
    } else {
      if (nameEl && !nameEl.value) nameEl.value = 'Elena Rostova';
      if (emailEl && !emailEl.value) emailEl.value = 'elena.rostova@example.com';
    }

    await filterCustomerReviews();
  }

  async function filterCustomerReviews() {
    const rating = (document.getElementById('reviewFilterRating') || {}).value || 'all';
    const roomNumber = (document.getElementById('reviewFilterRoom') || {}).value || 'all';
    const stayType = (document.getElementById('reviewFilterStayType') || {}).value || 'all';
    const sort = (document.getElementById('reviewFilterSort') || {}).value || 'newest';
    const search = ((document.getElementById('reviewFilterSearch') || {}).value || '').trim();

    const qs = new URLSearchParams({
      rating,
      roomNumber,
      stayType,
      sort,
      search
    });

    try {
      const data = await apiFetch(`/api/reviews?${qs.toString()}`);
      renderReviewsSummaryBanner(data.summary || {}, (data.reviews || []).length);
      renderCustomerReviewsList(data.reviews || []);
    } catch (err) {
      console.error('Failed to load customer reviews:', err);
    }
  }

  function renderReviewsSummaryBanner(summary, matchingCount) {
    const banner = document.getElementById('reviewsSummaryBanner');
    if (!banner) return;

    const total = Number(summary.totalReviews || 0);
    const avg = Number(summary.averageRating || 5).toFixed(2);
    const verified = Number(summary.verifiedCount || total);
    const dist = summary.distribution || { 5: total, 4: 0, 3: 0, 2: 0, 1: 0 };

    const barRow = (star) => {
      const cnt = Number(dist[star] || 0);
      const pct = total > 0 ? Math.round((cnt / total) * 100) : 0;
      return `
        <div style="display:grid;grid-template-columns:56px 1fr 48px;align-items:center;gap:0.55rem;font-size:0.78rem;">
          <span style="color:var(--gold-bright);font-weight:700;">${star} ★</span>
          <div style="height:8px;background:rgba(255,255,255,0.12);border-radius:999px;overflow:hidden;">
            <div style="width:${pct}%;height:100%;background:linear-gradient(90deg,var(--gold-primary),var(--gold-bright));"></div>
          </div>
          <span style="text-align:right;color:#cbd5e1;">${cnt} (${pct}%)</span>
        </div>
      `;
    };

    banner.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1.5rem;align-items:center;">
        <!-- Overall Score Column -->
        <div style="border-right:1px solid rgba(255,255,255,0.12);padding-right:1rem;">
          <span class="staging-badge" style="margin-bottom:0.4rem;display:inline-block;">LEADING PALACES OF THE WORLD INDEX</span>
          <div style="display:flex;align-items:baseline;gap:0.65rem;">
            <span style="font-family:var(--font-serif);font-size:3.1rem;font-weight:700;color:var(--gold-bright);line-height:1;">${avg}</span>
            <span style="font-size:1rem;color:#94a3b8;">/ 5.00 ★</span>
          </div>
          <div style="color:var(--gold-bright);font-size:1.1rem;letter-spacing:2px;margin:0.25rem 0;">★★★★★</div>
          <p style="font-size:0.82rem;color:#cbd5e1;margin-top:0.25rem;">
            Based on <strong>${total} Customer Reviews</strong> (${verified} Verified Palace Stays) • Showing <strong>${matchingCount}</strong> matching filter
          </p>
        </div>

        <!-- Star Distribution Bars -->
        <div style="display:flex;flex-direction:column;gap:0.35rem;">
          ${barRow(5)}
          ${barRow(4)}
          ${barRow(3)}
          ${barRow(2)}
          ${barRow(1)}
        </div>

        <!-- 4 Hospitality Pillar Sub-Scores -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.65rem;">
          <div style="background:rgba(255,255,255,0.05);border:1px solid rgba(212,175,99,0.28);border-radius:var(--radius-sm);padding:0.65rem 0.8rem;">
            <div style="font-size:0.72rem;color:#94a3b8;text-transform:uppercase;">Suite Architecture &amp; Savoir Beds</div>
            <div style="font-family:var(--font-serif);font-size:1.3rem;color:var(--gold-bright);font-weight:700;">4.98 / 5.0</div>
          </div>
          <div style="background:rgba(255,255,255,0.05);border:1px solid rgba(212,175,99,0.28);border-radius:var(--radius-sm);padding:0.65rem 0.8rem;">
            <div style="font-size:0.72rem;color:#94a3b8;text-transform:uppercase;">Private Butler &amp; Chauffeur</div>
            <div style="font-family:var(--font-serif);font-size:1.3rem;color:var(--gold-bright);font-weight:700;">4.96 / 5.0</div>
          </div>
          <div style="background:rgba(255,255,255,0.05);border:1px solid rgba(212,175,99,0.28);border-radius:var(--radius-sm);padding:0.65rem 0.8rem;">
            <div style="font-size:0.72rem;color:#94a3b8;text-transform:uppercase;">Le Jardin d’Or 3★ Michelin</div>
            <div style="font-family:var(--font-serif);font-size:1.3rem;color:var(--gold-bright);font-weight:700;">5.00 / 5.0</div>
          </div>
          <div style="background:rgba(255,255,255,0.05);border:1px solid rgba(212,175,99,0.28);border-radius:var(--radius-sm);padding:0.65rem 0.8rem;">
            <div style="font-size:0.72rem;color:#94a3b8;text-transform:uppercase;">Thermal Spa &amp; Helipad</div>
            <div style="font-family:var(--font-serif);font-size:1.3rem;color:var(--gold-bright);font-weight:700;">4.95 / 5.0</div>
          </div>
        </div>
      </div>
    `;
  }

  function renderCustomerReviewsList(reviews) {
    const container = document.getElementById('customerReviewsListContainer');
    if (!container) return;

    if (!reviews || reviews.length === 0) {
      container.innerHTML = `
        <div class="price-summary-card" style="position:static;text-align:center;padding:2.5rem;">
          <h4 style="font-family:var(--font-serif);font-size:1.35rem;margin-bottom:0.4rem;">No Customer Reviews Match Your Current Filter</h4>
          <p style="font-size:0.86rem;color:var(--text-muted);margin-bottom:1rem;">
            Try clearing your search filter or be the first to write a review for this residence category.
          </p>
          <button type="button" class="btn-secondary" onclick="window.AureliaApp.resetCustomerReviewFilters()">Reset All Review Filters</button>
        </div>
      `;
      return;
    }

    container.innerHTML = reviews.map((rv) => {
      const stars = '★'.repeat(Math.max(1, Math.min(5, Number(rv.rating || 5)))) + '☆'.repeat(5 - Math.max(1, Math.min(5, Number(rv.rating || 5))));
      const dateStr = String(rv.created_at || '').slice(0, 10);
      return `
        <article class="price-summary-card" style="position:static;background:#ffffff;border-left:4px solid var(--gold-primary);">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.55rem;">
            <div>
              <span style="color:var(--gold-primary);font-size:1.05rem;letter-spacing:1.5px;font-weight:700;">${stars}</span>
              <span class="status-pill confirmed" style="margin-left:0.45rem;font-size:0.7rem;">✓ VERIFIED PALACE STAY</span>
              <span class="staging-badge" style="background:#0f172a;color:var(--gold-bright);margin-left:0.35rem;font-size:0.7rem;">
                Room #${escapeHtml(rv.room_number || 'Suite')} • ${escapeHtml(rv.category_name || 'Palace Residence')}
              </span>
              <span style="font-size:0.72rem;background:#f1f5f9;color:#334155;padding:0.18rem 0.55rem;border-radius:999px;margin-left:0.3rem;font-weight:600;">
                ${escapeHtml(rv.stay_type || 'Couple & Leisure')}
              </span>
            </div>
            <span style="font-size:0.76rem;color:var(--text-muted);">
              Ref: <code>${escapeHtml(rv.booking_reference || 'AUR-VERIFIED')}</code> • ${escapeHtml(dateStr)}
            </span>
          </div>

          <h4 style="font-family:var(--font-serif);font-size:1.3rem;margin-bottom:0.45rem;color:var(--text-primary);">
            "${escapeHtml(rv.title)}"
          </h4>

          <p style="font-size:0.88rem;line-height:1.65;color:#334155;margin-bottom:0.85rem;">
            ${escapeHtml(rv.comment)}
          </p>

          ${rv.admin_response ? `
            <div style="margin:0.75rem 0;padding:0.8rem 1rem;background:#faf8f5;border-left:3px solid #0f172a;border-radius:var(--radius-sm);">
              <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.75rem;font-weight:700;color:#0f172a;margin-bottom:0.25rem;">
                <span>🏰 Official Response from ${escapeHtml(rv.admin_responder_name || 'Maison Aurélia Palace Management')}</span>
                <span style="font-weight:400;color:var(--text-muted);">${escapeHtml(String(rv.admin_responded_at || '').slice(0, 10))}</span>
              </div>
              <p style="font-size:0.82rem;color:#475569;margin:0;line-height:1.5;">
                ${escapeHtml(rv.admin_response)}
              </p>
            </div>
          ` : ''}

          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;padding-top:0.65rem;border-top:1px solid var(--border-subtle);font-size:0.8rem;">
            <div>
              <strong style="color:var(--text-primary);">${escapeHtml(rv.guest_name)}</strong>
              <span style="color:var(--text-muted);"> • ${escapeHtml(rv.guest_country || 'Switzerland')}</span>
            </div>

            <div style="display:flex;gap:0.45rem;align-items:center;flex-wrap:wrap;">
              <button type="button" class="nearby-date-btn" style="font-size:0.75rem;" onclick="window.AureliaApp.voteReviewHelpful(${rv.id})">
                👍 Helpful (${Number(rv.helpful_count || 0)})
              </button>
              <button type="button" class="nearby-date-btn" style="font-size:0.75rem;" onclick="window.AureliaApp.toggleAdminReplyBox(${rv.id})">
                💬 ${rv.admin_response ? 'Update Admin Response' : 'Post Admin Response'}
              </button>
            </div>
          </div>

          <!-- Collapsible Admin Management Reply Box -->
          <div id="adminReplyBox-${rv.id}" class="hidden" style="margin-top:0.75rem;padding-top:0.75rem;border-top:1px dashed var(--border-subtle);">
            <form onsubmit="window.AureliaApp.submitAdminReviewReply(event, ${rv.id})" style="display:flex;gap:0.5rem;flex-wrap:wrap;">
              <input type="text" id="adminReplyInput-${rv.id}" value="${escapeHtml(rv.admin_response || '')}" placeholder="Write an official Palace Director response to ${escapeHtml(rv.guest_name)}..." required style="flex:1;min-width:220px;padding:0.5rem 0.75rem;border:1px solid var(--border-subtle);border-radius:var(--radius-sm);font-size:0.82rem;" />
              <button type="submit" class="btn-primary" style="padding:0.5rem 0.9rem;font-size:0.78rem;">Publish Management Reply</button>
            </form>
          </div>
        </article>
      `;
    }).join('');
  }

  function resetCustomerReviewFilters() {
    if (document.getElementById('reviewFilterRating')) document.getElementById('reviewFilterRating').value = 'all';
    if (document.getElementById('reviewFilterRoom')) document.getElementById('reviewFilterRoom').value = 'all';
    if (document.getElementById('reviewFilterStayType')) document.getElementById('reviewFilterStayType').value = 'all';
    if (document.getElementById('reviewFilterSort')) document.getElementById('reviewFilterSort').value = 'newest';
    if (document.getElementById('reviewFilterSearch')) document.getElementById('reviewFilterSearch').value = '';
    filterCustomerReviews();
  }

  function setCustomerReviewRating(star) {
    const num = Math.max(1, Math.min(5, Number(star) || 5));
    const hiddenInput = document.getElementById('reviewFormRating');
    if (hiddenInput) hiddenInput.value = String(num);

    document.querySelectorAll('.review-star-btn').forEach((btn) => {
      const btnStar = Number(btn.getAttribute('data-star'));
      const active = btnStar === num;
      btn.style.background = active ? 'rgba(212,175,99,0.2)' : '';
      btn.style.borderColor = active ? 'var(--gold-primary)' : '';
      btn.style.color = active ? '#92400e' : '';
      btn.style.fontWeight = active ? '700' : '400';
    });
  }

  function fillCustomerReviewPreset(presetKey) {
    setCustomerReviewRating(5);
    const roomEl = document.getElementById('reviewRoomNumber');
    const stayEl = document.getElementById('reviewStayType');
    const titleEl = document.getElementById('reviewTitle');
    const commentEl = document.getElementById('reviewComment');

    if (presetKey === 'presidential') {
      if (roomEl) roomEl.value = '701';
      if (stayEl) stayEl.value = 'VIP Diplomatic & Executive';
      if (titleEl) titleEl.value = 'Unmatched Privacy, Private Helipad Arrival & Bespoke Butler Service';
      if (commentEl) {
        commentEl.value = 'Our three-night stay in The Imperial Presidential Residence (#701) exceeded every expectation. From the Steinway grand piano in our private salon to the in-suite Calacatta marble sauna and 24/7 butler team, Maison Aurélia is the pinnacle of Swiss hospitality.';
      }
    } else if (presetKey === 'penthouse') {
      if (roomEl) roomEl.value = 'PH-01';
      if (stayEl) stayEl.value = 'Honeymoon & Anniversary';
      if (titleEl) titleEl.value = 'Breathtaking Sunset Views from Our Heated Rooftop Infinity Plunge Pool';
      if (commentEl) {
        commentEl.value = 'The Sky Crown Duplex Penthouse (#PH-01) is an architectural triumph. Having a private 32°C rooftop infinity pool and Grand Cru wine vault across two floors made our celebration unforgettable.';
      }
    } else if (presetKey === 'spa') {
      if (roomEl) roomEl.value = '501';
      if (stayEl) stayEl.value = 'Gastronomy & Wellness';
      if (titleEl) titleEl.value = 'Three-Michelin-Starred Tasting Menu & Travertine Thermal Sanctuary';
      if (commentEl) {
        commentEl.value = 'Combining the Grand Aurélia Salon Suite (#501) with the 90-minute Gold Leaf Hammam ritual and the Chef’s Table at Le Jardin d’Or created the most restorative weekend we have ever experienced in Geneva.';
      }
    }
  }

  async function handleCustomerReviewPageSubmit(e) {
    e.preventDefault();
    const rating = Number((document.getElementById('reviewFormRating') || {}).value || 5);
    const guestName = document.getElementById('reviewGuestName').value.trim();
    const guestCountry = document.getElementById('reviewGuestCountry').value.trim() || 'Switzerland';
    const guestEmail = document.getElementById('reviewGuestEmail').value.trim();
    const bookingReference = document.getElementById('reviewBookingRef').value.trim();
    const roomSelect = document.getElementById('reviewRoomNumber');
    const roomNumber = roomSelect.value;
    const categoryName = roomSelect.options[roomSelect.selectedIndex].text.split('•')[1]?.trim() || 'Palace Suite';
    const stayType = document.getElementById('reviewStayType').value;
    const title = document.getElementById('reviewTitle').value.trim();
    const comment = document.getElementById('reviewComment').value.trim();

    try {
      const res = await apiFetch('/api/reviews', {
        method: 'POST',
        body: JSON.stringify({
          rating,
          guestName,
          guestCountry,
          guestEmail,
          bookingReference,
          roomNumber,
          categoryName,
          stayType,
          title,
          comment
        })
      });

      document.getElementById('reviewTitle').value = '';
      document.getElementById('reviewComment').value = '';

      const box = document.getElementById('reviewSubmissionResultBox');
      if (box) {
        box.classList.remove('hidden');
        box.innerHTML = `
          <div class="availability-box is-available" style="margin-top:0;">
            <div class="availability-box-heading">
              ✓ Thank You, ${escapeHtml(res.review.guest_name)} — Your ${res.review.rating}★ Review Is Live!
            </div>
            <p style="font-size:0.82rem;margin:0.35rem 0 0;">
              Published for <strong>Room #${escapeHtml(res.review.room_number)} (${escapeHtml(res.review.category_name)})</strong> under reference <code>${escapeHtml(res.review.booking_reference)}</code>.
            </p>
          </div>
        `;
      }

      await filterCustomerReviews();
    } catch (err) {
      alert(err.message);
    }
  }

  async function voteReviewHelpful(reviewId) {
    try {
      await apiFetch(`/api/reviews/${reviewId}/helpful`, { method: 'POST' });
      await filterCustomerReviews();
    } catch (err) {
      alert(err.message);
    }
  }

  function toggleAdminReplyBox(reviewId) {
    const box = document.getElementById(`adminReplyBox-${reviewId}`);
    if (box) box.classList.toggle('hidden');
  }

  async function submitAdminReviewReply(e, reviewId) {
    e.preventDefault();
    const input = document.getElementById(`adminReplyInput-${reviewId}`);
    const responseText = input ? input.value.trim() : '';
    if (!responseText) return;

    try {
      // Ensure staff auth token is active so the admin reply succeeds seamlessly in demo mode
      if (!state.currentUser || !['admin', 'manager', 'receptionist', 'finance'].includes(state.currentUser.role)) {
        const loginRes = await apiFetch('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({
            email: 'admin@maisonaurelia.luxury',
            password: 'AureliaAdmin!2026'
          })
        });
        state.authToken = loginRes.token;
        state.currentUser = loginRes.user;
        localStorage.setItem('aurelia_auth_token', state.authToken);
      }

      await apiFetch(`/api/admin/reviews/${reviewId}/reply`, {
        method: 'POST',
        body: JSON.stringify({ responseText })
      });
      await filterCustomerReviews();
    } catch (err) {
      alert(err.message);
    }
  }

  // -------------------------------------------------------------------------
  // Contact Page Interactive Map & Direct-to-Admin-Inbox Messaging
  // -------------------------------------------------------------------------

  const CONTACT_MAP_PINS = {
    palace: {
      badge: 'PALACE FLAGSHIP COORDINATES',
      title: 'Maison Aurélia Grand Palace & Sanctuary',
      coords: '46.2085° N, 6.1496° E',
      desc: '18 Quai du Mont-Blanc, 1201 Geneva, Switzerland. Private gated courtyard with 24/7 Rolls-Royce valet reception, underground armoured garage, and direct waterfront promenade access.',
      transfer: 'Rolls-Royce Chauffeur Standby: Immediate On-Site',
      department: 'Head Concierge & Admin',
      defaultSubject: 'General Palace Inquiry & VIP Concierge Assistance'
    },
    airport: {
      badge: 'PRIVATE AVIATION & VIP TARMAC',
      title: 'Geneva International Airport (GVA) VIP Terminal',
      coords: '46.2381° N, 6.1089° E',
      desc: 'Direct tarmac meet-and-greet at Geneva Executive Aviation & Commercial VIP Wing. Customs & luggage handled privately by our Diplomatic Attaché before boarding our Rolls-Royce Phantom VIII.',
      transfer: 'Rolls-Royce Phantom VIII Transfer Time: 15 Minutes (6.8 km)',
      department: 'Private Aviation & Chauffeur',
      defaultSubject: 'Rolls-Royce Airport Tarmac Pickup Request (GVA)'
    },
    helipad: {
      badge: 'ROOFTOP HELIPAD H1 (ICAO: LSMA)',
      title: 'Maison Aurélia Sky Crown Helipad H1',
      coords: '46.2088° N, 6.1502° E',
      desc: 'Certified twin-turbine rooftop helipad atop the 9th-floor Sky Crown wing for direct alpine transfers from Courchevel, Gstaad, Zermatt, and Zurich.',
      transfer: 'Private Security Lift Direct to Presidential & Penthouse Suites: 90 Seconds',
      department: 'Private Aviation & Chauffeur',
      defaultSubject: 'Rooftop Helipad H1 Landing Slot & Alpine Transfer Clearance'
    },
    pier: {
      badge: 'LAKE GENEVA PRIVATE MARINA',
      title: 'Maison Aurélia Private Yacht Pier #4',
      coords: '46.2076° N, 6.1498° E',
      desc: 'Exclusive Riva Aquarama & private tender mooring directly across the Quai du Mont-Blanc promenade, with private champagne embarkation.',
      transfer: 'Private Escort from Palace Courtyard to Yacht Pier #4: 2 Minutes',
      department: 'Head Concierge & Admin',
      defaultSubject: 'Private Yacht Pier #4 Mooring & Riva Lake Charter Inquiry'
    },
    rail: {
      badge: 'INTERNATIONAL HIGH-SPEED RAIL HUB',
      title: 'Geneva Cornavin Grand Rail Terminal',
      coords: '46.2102° N, 6.1424° E',
      desc: 'First-class platform porter & chauffeur reception for TGV Lyria and Swiss Federal Railways arrivals.',
      transfer: 'Rolls-Royce Phantom VIII Transfer Time: 6 Minutes (1.4 km)',
      department: 'Private Aviation & Chauffeur',
      defaultSubject: 'Cornavin Rail Terminal Chauffeur & Luggage Escort'
    }
  };

  let currentContactMapPinKey = 'palace';

  function initContactPage() {
    const nameEl = document.getElementById('contactGuestName');
    const emailEl = document.getElementById('contactGuestEmail');
    const phoneEl = document.getElementById('contactGuestPhone');

    if (state.currentUser) {
      if (nameEl && !nameEl.value) {
        nameEl.value = `${state.currentUser.first_name || ''} ${state.currentUser.last_name || ''}`.trim();
      }
      if (emailEl && !emailEl.value) {
        emailEl.value = state.currentUser.email || '';
      }
      if (phoneEl && !phoneEl.value && state.currentUser.phone) {
        phoneEl.value = state.currentUser.phone;
      }
    } else {
      if (nameEl && !nameEl.value) nameEl.value = 'Elena Rostova';
      if (emailEl && !emailEl.value) emailEl.value = 'elena.rostova@example.com';
      if (phoneEl && !phoneEl.value) phoneEl.value = '+41 79 555 0192';
    }
  }

  function setContactMapMode(mode) {
    document.querySelectorAll('.contact-map-mode-btn').forEach((btn) => {
      const isMatch = btn.getAttribute('data-mode') === mode;
      btn.style.background = isMatch ? 'rgba(212,175,99,0.22)' : 'rgba(255,255,255,0.06)';
      btn.style.color = isMatch ? 'var(--gold-bright)' : '#e2e8f0';
      btn.style.borderColor = isMatch ? 'var(--gold-primary)' : '#334155';
    });

    const routeLine = document.getElementById('mapRouteCorridorLine');
    if (mode === 'aviation') {
      if (routeLine) routeLine.setAttribute('d', 'M85,52 Q165,85 215,130 L350,155 L435,128');
      selectContactMapPin('airport');
    } else if (mode === 'marina') {
      if (routeLine) routeLine.setAttribute('d', 'M350,155 L350,238 L545,255');
      selectContactMapPin('pier');
    } else {
      if (routeLine) routeLine.setAttribute('d', 'M215,130 L350,155');
      selectContactMapPin('palace');
    }
  }

  function selectContactMapPin(pinKey) {
    const pin = CONTACT_MAP_PINS[pinKey] || CONTACT_MAP_PINS.palace;
    currentContactMapPinKey = pinKey in CONTACT_MAP_PINS ? pinKey : 'palace';

    const badgeEl = document.getElementById('contactPinBadge');
    const titleEl = document.getElementById('contactPinTitle');
    const coordsEl = document.getElementById('contactPinCoords');
    const descEl = document.getElementById('contactPinDesc');
    const transferEl = document.getElementById('contactPinTransferTime');
    const mapPointInput = document.getElementById('contactMapPoint');

    if (badgeEl) badgeEl.textContent = pin.badge;
    if (titleEl) titleEl.textContent = pin.title;
    if (coordsEl) coordsEl.textContent = pin.coords;
    if (descEl) descEl.textContent = pin.desc;
    if (transferEl) transferEl.textContent = pin.transfer;
    if (mapPointInput) mapPointInput.value = `${pin.title} (${pin.coords})`;
  }

  function applyMapPinToContactForm() {
    const pin = CONTACT_MAP_PINS[currentContactMapPinKey] || CONTACT_MAP_PINS.palace;
    const mapPointInput = document.getElementById('contactMapPoint');
    const deptSelect = document.getElementById('contactDepartment');
    const subjInput = document.getElementById('contactSubject');
    const bodyInput = document.getElementById('contactMessageBody');

    if (mapPointInput) mapPointInput.value = `${pin.title} (${pin.coords})`;
    if (deptSelect) deptSelect.value = pin.department;
    if (subjInput && !subjInput.value) subjInput.value = pin.defaultSubject;
    if (bodyInput) {
      if (!bodyInput.value) {
        bodyInput.value = `Bonjour Concierge Team, I would like to arrange assistance regarding ${pin.title} (${pin.coords}). Please confirm availability and scheduling details.`;
      }
      bodyInput.focus();
    }
  }

  function fillContactPreset(presetKey) {
    const deptSelect = document.getElementById('contactDepartment');
    const prioSelect = document.getElementById('contactPriority');
    const subjInput = document.getElementById('contactSubject');
    const bodyInput = document.getElementById('contactMessageBody');

    if (presetKey === 'airport') {
      selectContactMapPin('airport');
      if (deptSelect) deptSelect.value = 'Private Aviation & Chauffeur';
      if (prioSelect) prioSelect.value = 'vip_urgent';
      if (subjInput) subjInput.value = 'Rolls-Royce Phantom VIII Airport Tarmac Pickup (Flight LX-2804)';
      if (bodyInput) {
        bodyInput.value = 'We are arriving at Geneva International Airport (GVA) VIP Terminal at 16:30. Please dispatch the Rolls-Royce Phantom VIII chauffeur and arrange direct suite check-in.';
      }
    } else if (presetKey === 'viewing') {
      selectContactMapPin('palace');
      if (deptSelect) deptSelect.value = 'Head Concierge & Admin';
      if (prioSelect) prioSelect.value = 'normal';
      if (subjInput) subjInput.value = 'Private Architectural Viewing of The Imperial Presidential Suite (#701)';
      if (bodyInput) {
        bodyInput.value = 'I would like to schedule a private viewing of The Imperial Presidential Residence (#701) and Sky Penthouse (#PH-01) with the Palace Director this Friday afternoon.';
      }
    } else if (presetKey === 'dining') {
      selectContactMapPin('palace');
      if (deptSelect) deptSelect.value = 'Dining & Thermal Sanctuary';
      if (prioSelect) prioSelect.value = 'normal';
      if (subjInput) subjInput.value = "Private Sommelier Cellar & 2★ Michelin Chef's Table Inquiry";
      if (bodyInput) {
        bodyInput.value = "Could you reserve the Chef's Table at L'Orangerie du Lac for 4 guests this Saturday at 20:00, paired with your vintage Krug & Grand Cru Burgundy tasting flight?";
      }
    } else if (presetKey === 'helipad') {
      selectContactMapPin('helipad');
      if (deptSelect) deptSelect.value = 'Private Aviation & Chauffeur';
      if (prioSelect) prioSelect.value = 'vip_urgent';
      if (subjInput) subjInput.value = 'Rooftop Helipad H1 (ICAO: LSMA) Landing Clearance Request';
      if (bodyInput) {
        bodyInput.value = 'Requesting landing slot clearance on Rooftop Helipad H1 for our AgustaWestland AW139 helicopter departing Gstaad at 14:15 tomorrow.';
      }
    }
  }

  async function handleContactPageSubmit(e) {
    e.preventDefault();
    const guestName = document.getElementById('contactGuestName').value.trim();
    const guestEmail = document.getElementById('contactGuestEmail').value.trim();
    const guestPhone = document.getElementById('contactGuestPhone').value.trim();
    const bookingReference = document.getElementById('contactBookingRef').value.trim();
    const department = document.getElementById('contactDepartment').value;
    const priority = document.getElementById('contactPriority').value;
    const mapPoint = document.getElementById('contactMapPoint').value.trim();
    const subject = document.getElementById('contactSubject').value.trim();
    const message = document.getElementById('contactMessageBody').value.trim();

    try {
      const res = await apiFetch('/api/contact/messages', {
        method: 'POST',
        body: JSON.stringify({
          guestName,
          guestEmail,
          guestPhone,
          bookingReference,
          department,
          priority,
          mapPoint,
          subject,
          message
        })
      });

      const thread = res.thread;
      state.selectedAdminThreadId = thread.id;
      state.selectedGuestThreadId = thread.id;

      // Clear subject & message body after sending
      document.getElementById('contactSubject').value = '';
      document.getElementById('contactMessageBody').value = '';

      // Populate lookup fields automatically so the user can also track right below
      const lookupRefEl = document.getElementById('contactLookupRef');
      const lookupEmailEl = document.getElementById('contactLookupEmail');
      if (lookupRefEl) lookupRefEl.value = thread.thread_reference;
      if (lookupEmailEl) lookupEmailEl.value = thread.guest_email;

      const resultBox = document.getElementById('contactSubmissionResultBox');
      if (resultBox) {
        resultBox.classList.remove('hidden');
        resultBox.innerHTML = `
          <div class="availability-box is-available" style="margin-top:0;">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;">
              <div class="availability-box-heading" style="margin-bottom:0;">
                ✓ Message Delivered to Admin Messaging Inbox (<code>${escapeHtml(thread.thread_reference)}</code>)
              </div>
              <span class="status-pill confirmed">UNREAD IN ADMIN INBOX</span>
            </div>
            <p style="font-size:0.83rem;margin:0.45rem 0;">
              Your inquiry <strong>"${escapeHtml(thread.subject)}"</strong> for <strong>${escapeHtml(thread.department)}</strong> has been routed directly to the <strong>Admin Messaging Inbox</strong>.
            </p>
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.65rem;">
              <button type="button" class="btn-primary" style="padding:0.45rem 0.9rem;font-size:0.78rem;" onclick="window.AureliaApp.openThreadInAdminInbox(${thread.id})">
                💬 Open This Message in Admin Inbox Now (${escapeHtml(thread.thread_reference)}) &rarr;
              </button>
              <button type="button" class="btn-secondary" style="padding:0.45rem 0.9rem;font-size:0.78rem;" onclick="window.AureliaApp.switchToGuestMessagingInbox()">
                👤 View in My Guest Inbox
              </button>
            </div>
          </div>
        `;
      }

      renderContactThreadConversation(thread);
    } catch (err) {
      alert(err.message);
    }
  }

  async function openThreadInAdminInbox(threadId) {
    state.selectedAdminThreadId = Number(threadId);
    await switchToAdminMessagingInbox();
  }

  async function handleContactThreadLookup(e) {
    if (e) e.preventDefault();
    const ref = document.getElementById('contactLookupRef').value.trim();
    const email = document.getElementById('contactLookupEmail').value.trim();

    try {
      const res = await apiFetch(
        `/api/contact/messages/lookup?threadReference=${encodeURIComponent(ref)}&email=${encodeURIComponent(email)}`
      );
      renderContactThreadConversation(res.thread);
    } catch (err) {
      const box = document.getElementById('contactThreadLookupResult');
      if (box) {
        box.innerHTML = `
          <div class="availability-box is-unavailable" style="margin-top:0;">
            <div class="availability-box-heading">Thread Lookup Notice</div>
            <p style="font-size:0.82rem;">${escapeHtml(err.message)}</p>
          </div>
        `;
      }
    }
  }

  function renderContactThreadConversation(thread) {
    const box = document.getElementById('contactThreadLookupResult');
    if (!box || !thread) return;

    box.innerHTML = `
      <div style="border:1px solid var(--border-subtle);border-radius:var(--radius-sm);padding:0.95rem;background:#faf8f5;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:0.5rem;padding-bottom:0.65rem;border-bottom:1px solid var(--border-subtle);margin-bottom:0.75rem;">
          <div>
            <span class="staging-badge" style="background:#0f172a;color:var(--gold-bright);">${escapeHtml(thread.thread_reference)}</span>
            <strong style="font-size:0.95rem;margin-left:0.35rem;">${escapeHtml(thread.subject)}</strong>
            <div style="font-size:0.76rem;color:var(--text-muted);margin-top:0.2rem;">
              Department: <strong>${escapeHtml(thread.department)}</strong> • Status: <span class="status-pill ${thread.status === 'resolved' ? 'confirmed' : 'pending'}">${escapeHtml(thread.status)}</span>
            </div>
          </div>
          <button type="button" class="nearby-date-btn" style="font-size:0.74rem;" onclick="window.AureliaApp.openThreadInAdminInbox(${thread.id})">
            Reply as Admin in Admin Console &rarr;
          </button>
        </div>

        <div style="display:flex;flex-direction:column;gap:0.65rem;max-height:280px;overflow-y:auto;margin-bottom:0.8rem;padding-right:0.25rem;">
          ${(thread.messages || []).map((m) => {
            const isGuest = m.sender_role === 'guest';
            return `
              <div style="align-self:${isGuest ? 'flex-end' : 'flex-start'};max-width:88%;background:${isGuest ? '#1e293b' : '#ffffff'};color:${isGuest ? '#f8fafc' : 'var(--text-primary)'};border:1px solid ${isGuest ? '#334155' : 'var(--gold-primary)'};border-radius:var(--radius-sm);padding:0.65rem 0.85rem;">
                <div style="display:flex;justify-content:space-between;gap:0.75rem;font-size:0.72rem;margin-bottom:0.25rem;color:${isGuest ? 'var(--gold-bright)' : 'var(--gold-primary)'};font-weight:700;">
                  <span>${escapeHtml(m.sender_name)} (${isGuest ? 'Guest' : 'Admin / Concierge'})</span>
                  <span style="opacity:0.8;font-weight:400;">${escapeHtml(m.created_at || '')}</span>
                </div>
                <div style="font-size:0.83rem;line-height:1.45;white-space:pre-wrap;">${escapeHtml(m.body)}</div>
              </div>
            `;
          }).join('')}
        </div>

        <form onsubmit="window.AureliaApp.handleContactThreadReplySubmit(event, '${escapeHtml(thread.thread_reference)}', '${escapeHtml(thread.guest_email)}')">
          <div style="display:flex;gap:0.5rem;">
            <input type="text" id="contactInlineReplyInput" placeholder="Write a follow-up reply to Admin..." required style="flex:1;padding:0.55rem;border:1px solid var(--border-subtle);border-radius:var(--radius-sm);font-size:0.83rem;" />
            <button type="submit" class="btn-primary" style="padding:0.55rem 0.95rem;font-size:0.8rem;">Send Reply</button>
          </div>
        </form>
      </div>
    `;
  }

  async function handleContactThreadReplySubmit(e, threadReference, email) {
    e.preventDefault();
    const input = document.getElementById('contactInlineReplyInput');
    const body = input ? input.value.trim() : '';
    if (!body) return;

    try {
      const res = await apiFetch(`/api/contact/messages/${encodeURIComponent(threadReference)}/reply`, {
        method: 'POST',
        body: JSON.stringify({ email, body })
      });
      renderContactThreadConversation(res.thread);
    } catch (err) {
      alert(err.message);
    }
  }

  window.AureliaApp = {
    init,
    setLanguage,
    setCurrency,
    switchView,
    scrollToSection,
    renderReviewsPage,
    filterCustomerReviews,
    resetCustomerReviewFilters,
    setCustomerReviewRating,
    fillCustomerReviewPreset,
    handleCustomerReviewPageSubmit,
    voteReviewHelpful,
    toggleAdminReplyBox,
    submitAdminReviewReply,
    initContactPage,
    setContactMapMode,
    selectContactMapPin,
    applyMapPinToContactForm,
    fillContactPreset,
    handleContactPageSubmit,
    openThreadInAdminInbox,
    handleContactThreadLookup,
    handleContactThreadReplySubmit,
    handleSearchSubmit,
    filterByCategory,
    applySuggestedDates,
    toggleMultiRoomSelection,
    clearMultiRoomSelection,
    startMultiRoomCheckout,
    openRoomDetailModal,
    closeRoomDetailModal,
    select3dSuite,
    update3dPerspective,
    initiateBookingForRooms,
    cancelActiveHold,
    reopenCheckoutModal,
    closeCheckoutModal,
    fillTestCard,
    toggleCheckoutAddon,
    setCheckoutPaymentPlan,
    setCheckoutPaymentMethod,
    applyCheckoutPromo,
    toggleCheckoutLoyaltyRedemption,
    promptJoinRoomWaitlist,
    submitAtomicReservation,
    showConfirmationModal,
    closeConfirmationModal,
    openBookingInLookup,
    handleLookupSubmit,
    promptCancelReservation,
    submitModifyReservationDates,
    submitUpdateSpecialRequests,
    submitPreArrivalDossier,
    submitVerifiedStayReview,
    submitFacilitySlotBooking,
    cancelFacilitySlotUI,
    voidFolioChargeUI,
    handleLoginSubmit,
    handleRegisterSubmit,
    logout,
    quickGuestLogin,
    switchGuestTab,
    openMessagingInboxDirect,
    switchToAdminMessagingInbox,
    switchToGuestMessagingInbox,
    markAllGuestMessagesRead,
    markAllAdminMessagesRead,
    filterAdminInbox,
    fillAdminQuickReply,
    handleAdminDeleteMessageThread,
    selectGuestMessageThread,
    handleGuestStartMessageSubmit,
    handleGuestReplyMessageSubmit,
    handleCreateConciergeRequestSubmit,
    cancelGuestWaitlistEntry,
    handleSaveGuestProfileSubmit,
    handleChangeGuestPasswordSubmit,
    quickStaffLogin,
    switchAdminTab,
    selectAdminMessageThread,
    handleAdminStartNewThreadSubmit,
    handleAdminReplyMessageSubmit,
    handleAdminUpdateThreadStatus,
    handleAdminWalkInSubmit,
    adminUpdateBookingStatus,
    adminConfirmBalancePayment,
    adminIssueRefund,
    handlePostFolioChargeSubmit,
    handleAddRoomSubmit,
    handleAddCategorySubmit,
    saveRoomQuickEdit,
    saveRoomHousekeepingStatus,
    handleHousekeepingChecklistSubmit,
    deletePhysicalRoom,
    handleCreateMaintenanceSubmit,
    removeMaintenanceBlock,
    handleImportIcalSubmit,
    handleSaveSettingsSubmit,
    handleCreateSeasonalRateSubmit,
    deleteSeasonalRateUI,
    handleCreatePromoCodeSubmit,
    deletePromoCodeUI,
    updateStaffRoleUI,
    saveNotificationTemplateUI,
    verifyCloudAdapterHandshake,
    handleAdminCreateUserSubmit,
    handleAdminSaveUserRow,
    handleAdminDeleteUser,
    handleAdminUpdateConciergeRequest,
    triggerAdminDatabaseBackup
  };

  document.addEventListener('DOMContentLoaded', init);
})();
