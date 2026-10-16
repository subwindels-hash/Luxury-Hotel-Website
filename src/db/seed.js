const { getDb, withImmediateTransaction } = require('./database');
const { hashPassword } = require('../middleware/auth');

function seedDatabase(customDb = null) {
  const db = customDb || getDb();

  const existingSettings = db.prepare('SELECT id FROM hotel_settings WHERE id = 1').get();
  if (existingSettings) {
    return { seeded: false, message: 'Database already initialized.' };
  }

  return withImmediateTransaction(db, () => {
    // 1. Hotel Global Settings
    db.prepare(`
      INSERT INTO hotel_settings (
        id, hotel_name, brand_tagline, environment_mode, environment_banner,
        timezone, base_currency, check_in_time, check_out_time, same_day_turnover,
        tax_rate_percent, service_fee_percent, city_levy_per_night, deposit_percent,
        hold_duration_minutes, free_cancellation_hours, late_cancellation_penalty_percent,
        allow_pay_at_hotel, contact_email, contact_phone, address
      ) VALUES (
        1,
        'Maison Aurélia Grand Palace & Sanctuary',
        'Where Heritage Architecture Meets Five-Star Contemporary Sanctuary',
        'staging',
        'STAGING / SAMPLE INVENTORY — Initial rooms below are pre-configured sample inventory and can be added, edited, or removed in the Hotel Administration Dashboard.',
        'UTC',
        'USD',
        '15:00',
        '12:00',
        1,
        12.5,
        5.0,
        25.0,
        30.0,
        10,
        48,
        50.0,
        1,
        'concierge@maisonaurelia.luxury',
        '+41 22 819 0000',
        '18 Quai du Mont-Blanc, Waterfront Sanctuary Quarter'
      )
    `).run();

    // 2. Staff & Guest Users (RBAC Roles: admin, manager, receptionist, finance, guest)
    const usersToSeed = [
      {
        email: 'admin@maisonaurelia.luxury',
        pass: 'AureliaAdmin!2026',
        firstName: 'Henri',
        lastName: 'de Valois',
        phone: '+41 22 819 0001',
        country: 'Switzerland',
        role: 'admin',
        tier: 'Imperial Black',
        points: 25000
      },
      {
        email: 'manager@maisonaurelia.luxury',
        pass: 'AureliaManager!2026',
        firstName: 'Camille',
        lastName: 'Laurent',
        phone: '+41 22 819 0002',
        country: 'France',
        role: 'manager',
        tier: 'Imperial Black',
        points: 15000
      },
      {
        email: 'frontdesk@maisonaurelia.luxury',
        pass: 'AureliaDesk!2026',
        firstName: 'Mateo',
        lastName: 'Rossi',
        phone: '+41 22 819 0003',
        country: 'Italy',
        role: 'receptionist',
        tier: 'Gold Sanctuary',
        points: 5000
      },
      {
        email: 'finance@maisonaurelia.luxury',
        pass: 'AureliaFinance!2026',
        firstName: 'Amara',
        lastName: 'Okafor',
        phone: '+234 809 555 0190',
        country: 'Nigeria',
        role: 'finance',
        tier: 'Gold Sanctuary',
        points: 8000
      },
      {
        email: 'elena.rostova@example.com',
        pass: 'GuestPass!2026',
        firstName: 'Elena',
        lastName: 'Rostova',
        phone: '+44 20 7946 0921',
        country: 'United Kingdom',
        role: 'guest',
        tier: 'Imperial Black',
        points: 18400
      }
    ];

    const insertUser = db.prepare(`
      INSERT INTO users (email, password_hash, password_salt, first_name, last_name, phone, country, role, loyalty_tier, loyalty_points)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const u of usersToSeed) {
      const { salt, hash } = hashPassword(u.pass);
      insertUser.run(u.email, hash, salt, u.firstName, u.lastName, u.phone, u.country, u.role, u.tier, u.points);
    }

    // 3. Room Categories (All 10 categories from brief)
    const defaultPolicies = {
      checkIn: 'Check-in from 15:00 local hotel time. Early check-in from 11:00 subject to availability; valid government-issued photo ID and security guarantee required upon arrival.',
      checkOut: 'Check-out by 12:00 noon. Complimentary late check-out until 14:00 for Gold Sanctuary & Imperial Black members when available.',
      cancellation: 'Complimentary cancellation up to 48 hours prior to 15:00 on the day of arrival. Cancellations within 48 hours of arrival incur a 50% stay penalty.',
      refund: 'Eligible refunds are processed automatically back to the original payment method within 3–5 business days, with instant credit memo & audit receipt generation.'
    };

    const categories = [
      {
        slug: 'standard-rooms',
        name: 'Standard Rooms',
        short_description: 'Serene Neoclassical courtyard rooms crafted with Italian travertine and bespoke king bedding.',
        description: 'Our Classic Courtyard Standard Rooms offer an intimate sanctuary away from the bustle of the waterfront. Dressed in hand-loomed Loro Piana cashmeres, French walnut millwork, and Calacatta marble bath suites with heated floors.',
        base_price: 420,
        max_adults: 2,
        max_children: 1,
        max_occupancy: 2,
        bed_type: '1 Bespoke Emperor King Bed',
        size_sqm: 42,
        size_sqft: 452,
        hero_image: '/images/room-standard.jpg',
        gallery: ['/images/room-standard.jpg', '/images/room-deluxe.jpg', '/images/spa-sanctuary.jpg'],
        amenities: ['600-Thread-Count Quagliotti Linens', 'Calacatta Marble Rain Shower', 'Bang & Olufsen Acoustic System', 'Nespresso Creatista Coffee Atelier', 'High-Speed Private Wi-Fi 6E', 'Automated Blackout Silk Drapes'],
        facilities: ['24-Hour Thermal Spa Access', 'Technogym Wellness Studio', 'Valet Parking', 'Shoe Shine & Pressing Service'],
        included_services: ['Welcome Champagne Flute on Arrival', 'Evening Turndown Aromatherapy', 'Daily Artisanal Mineral Water'],
        is_featured: 0,
        sort_order: 1
      },
      {
        slug: 'deluxe-rooms',
        name: 'Deluxe Rooms',
        short_description: 'Sun-drenched botanical terrace rooms featuring private outdoor lounging and garden vistas.',
        description: 'Opening directly onto our landscaped cypress and jasmine gardens, Deluxe Rooms blend indoor refinement with alfresco tranquility. Enjoy morning espresso on your private stone terrace.',
        base_price: 580,
        max_adults: 2,
        max_children: 1,
        max_occupancy: 3,
        bed_type: '1 Emperor King Bed + Optional Daybed',
        size_sqm: 54,
        size_sqft: 581,
        hero_image: '/images/room-deluxe.jpg',
        gallery: ['/images/room-deluxe.jpg', '/images/room-standard.jpg', '/images/dining-michelin.jpg'],
        amenities: ['Private Furnished Garden Terrace', 'Deep-Soaking Freestanding Tub', 'Dyson Supersonic Hair Care', 'Curated Private Wine & Spirits Bar', 'Smart Climate & Mood Lighting Control', 'Pillow Menu (8 Bespoke Options)'],
        facilities: ['Indoor-Outdoor Infinity Pool', 'Thermal Hammam & Sauna', 'Private Botanical Garden Walkways'],
        included_services: ['Complimentary Garment Pressing (2 items)', 'Artisanal Swiss Praline Welcome Box', '24/7 Digital Butler Concierge'],
        is_featured: 1,
        sort_order: 2
      },
      {
        slug: 'superior-rooms',
        name: 'Superior Rooms',
        short_description: 'Elevated high-floor rooms with sweeping waterfront perspectives and reading lounge.',
        description: 'Positioned on the upper levels of the Main Palace Wing, Superior Rooms frame uninterrupted views over the glistening waterfront and alpine horizon through acoustic floor-to-ceiling glazing.',
        base_price: 660,
        max_adults: 2,
        max_children: 1,
        max_occupancy: 3,
        bed_type: '1 Emperor King Bed or 2 Luxury Queen Beds',
        size_sqm: 58,
        size_sqft: 624,
        hero_image: '/images/room-superior.jpg',
        gallery: ['/images/room-superior.jpg', '/images/room-executive.jpg', '/images/hero-palace.jpg'],
        amenities: ['Panoramic Waterfront Windows', 'Bespoke Reading Chaise Lounge', 'Dual Marble Vanities', 'Diptyque Paris Full-Size Bath Amenities', '4K OLED Gallery Television', 'In-Room Yoga & Meditation Kit'],
        facilities: ['Infinity Reflection Pool', '24-Hour Fitness & Pilates Atelier', 'House Bentley Local Drop-off (within 3km)'],
        included_services: ['Daily Fresh Cut Orchids', 'Evening Herbal Sommelier Tea Service', 'Priority Michelin Restaurant Booking'],
        is_featured: 0,
        sort_order: 3
      },
      {
        slug: 'executive-rooms',
        name: 'Executive Rooms',
        short_description: 'Sophisticated chambers with walnut study atelier and exclusive Club Aurélia Lounge privileges.',
        description: 'Tailored for discerning diplomats and global executives, Executive Rooms provide a dedicated leather-inlaid work sanctuary alongside full access to The Aurélia Club Lounge for private breakfast, afternoon tea, and evening vintage champagne.',
        base_price: 790,
        max_adults: 2,
        max_children: 1,
        max_occupancy: 3,
        bed_type: '1 Emperor King Bed',
        size_sqm: 65,
        size_sqft: 700,
        hero_image: '/images/room-executive.jpg',
        gallery: ['/images/room-executive.jpg', '/images/suite-luxury.jpg', '/images/dining-michelin.jpg'],
        amenities: ['Club Aurélia Lounge Access', 'Handcrafted Walnut Executive Desk', 'Private High-Security Safe with Watch Winder', '2-Hour Private Boardroom Usage Daily', 'Dual Rain & Steam Shower', 'Complimentary High-Speed Global VoIP'],
        facilities: ['Executive Club Library & Terrace', 'Private Chauffeur Fleet', 'Thermal Spa & Cryotherapy Suite'],
        included_services: ['Club Lounge Breakfast & Evening Canapés', 'Dedicated Executive Attaché', 'Express Airport Fast-Track Coordination'],
        is_featured: 1,
        sort_order: 4
      },
      {
        slug: 'junior-suites',
        name: 'Junior Suites',
        short_description: 'Open-plan architectural atelier suites with sculpted bouclé living salon and marble bath.',
        description: 'Our Junior Suites offer a seamless flow between sleeping quarters and an art-curated living salon. Warm travertine stone, custom brass luminaires, and a bar alcove make this ideal for extended stays.',
        base_price: 980,
        max_adults: 3,
        max_children: 1,
        max_occupancy: 3,
        bed_type: '1 Emperor King Bed + Luxury Sofa Bed',
        size_sqm: 78,
        size_sqft: 840,
        hero_image: '/images/suite-junior.jpg',
        gallery: ['/images/suite-junior.jpg', '/images/suite-luxury.jpg', '/images/spa-sanctuary.jpg'],
        amenities: ['Open-Plan Living Salon', 'Walk-In Couture Dressing Room', 'Freestanding Panoramic Marble Bath', 'Private Cocktail Mixology Station', 'Bang & Olufsen Beosound Theatre', 'Heated Towel & Robe Valet'],
        facilities: ['Private Cabana Reservation Priority', 'Thermal Sanctuary & Salt Grotto', 'Sommelier Wine Cellar Tastings'],
        included_services: ['Daily À La Carte Breakfast Included', 'Unpacking & Packing Butler Service', 'Complimentary One-Way Airport Transfer'],
        is_featured: 0,
        sort_order: 5
      },
      {
        slug: 'luxury-suites',
        name: 'Luxury Suites',
        short_description: 'Grand heritage one-bedroom residences with separate formal parlor, dining table, and soaking tub.',
        description: 'Graced with silk wall coverings, chevron oak parquetry, and double French doors separating the private bedroom from a grand reception parlor, the Luxury Suites embody residential European grandeur.',
        base_price: 1450,
        max_adults: 3,
        max_children: 2,
        max_occupancy: 4,
        bed_type: '1 Custom Savoir No. 2 King Bed',
        size_sqm: 110,
        size_sqft: 1184,
        hero_image: '/images/suite-luxury.jpg',
        gallery: ['/images/suite-luxury.jpg', '/images/suite-presidential.jpg', '/images/dining-michelin.jpg'],
        amenities: ['Separate Formal Living & Dining Parlor (Seats 6)', 'Guest Powder Room + Master Spa Bathroom', 'Private Steam Room in Master Bath', 'Curated Vintage Wine Fridge', 'Fireplace with Marble Mantel', '24-Hour Dedicated Personal Butler'],
        facilities: ['Private Spa Treatment Suite Access', 'Helipad & Yacht Pier Access', 'Michelin Chef Private In-Suite Dining'],
        included_services: ['Round-Trip Chauffeur Airport Transfers', 'Daily Michelin-Curated Breakfast', 'Bottle of Dom Pérignon Vintage on Arrival'],
        is_featured: 1,
        sort_order: 6
      },
      {
        slug: 'presidential-suites',
        name: 'Presidential Suites',
        short_description: 'The crown jewel 240m² wing featuring private wellness spa, dining hall, security foyer, and panoramic terrace.',
        description: 'Occupying the entire noble corner of the 7th floor, The Imperial Presidential Residence offers uncompromising privacy, ballistic-grade acoustic glazing, a private study, a 10-seat formal dining room with butler pantry, and a panoramic wrap-around terrace.',
        base_price: 3800,
        max_adults: 4,
        max_children: 2,
        max_occupancy: 6,
        bed_type: '2 Savoir Royal State King Bedrooms',
        size_sqm: 240,
        size_sqft: 2583,
        hero_image: '/images/suite-presidential.jpg',
        gallery: ['/images/suite-presidential.jpg', '/images/suite-penthouse.jpg', '/images/hero-palace.jpg', '/images/spa-sanctuary.jpg'],
        amenities: ['240m² Private Wing with Security Airlock', '10-Seat Formal Dining Hall & Butler Kitchen', 'In-Suite Private Sauna & Massage Room', 'Steinway Baby Grand Piano', 'Private Wrap-Around Waterfront Terrace', 'Dedicated 24/7 Chief Butler & Private Chef on Call'],
        facilities: ['Dedicated Rolls-Royce Phantom & Chauffeur During Stay', 'Private Elevator Keycard Access', 'Complimentary Private Cabana at Thermal Pool'],
        included_services: ['All-Inclusive In-Suite Breakfast & Evening Cocktails', 'VIP Tarmac & Private Jet FBO Meet-and-Greet', 'Daily 60-Minute In-Suite Spa Treatment'],
        is_featured: 1,
        sort_order: 7
      },
      {
        slug: 'family-rooms',
        name: 'Family Rooms',
        short_description: 'Spacious interconnecting family residences designed for multi-generational comfort and young explorers.',
        description: 'Thoughtfully architected with an interconnecting master king chamber and a twin queen sanctuary, plus a sunlit play and reading alcove. Includes our Little Aurélians children’s concierge program.',
        base_price: 860,
        max_adults: 4,
        max_children: 3,
        max_occupancy: 6,
        bed_type: '1 Emperor King Bed + 2 Luxury Queen Beds + Daybed',
        size_sqm: 95,
        size_sqft: 1022,
        hero_image: '/images/room-family.jpg',
        gallery: ['/images/room-family.jpg', '/images/room-deluxe.jpg', '/images/hero-palace.jpg'],
        amenities: ['Guaranteed Interconnecting Private Foyer', 'Two Full Marble Bathrooms with Tubs', 'Children’s Welcome Teepee & Cashmere Robes', 'Gaming Console & Family Cinema System', 'Kitchenette with Bottle Warmer & Organic Snacks', 'Childproofing & Certified Nanny Service Available'],
        facilities: ['Family Heated Garden Pool Hours', 'Private Cinema Room Booking', 'Botanical Treasure Hunt & Pastry Classes'],
        included_services: ['Complimentary Full Dining for Children Under 12', 'Family Concierge Itinerary Planning', 'Complimentary Laundry for Children’s Garments'],
        is_featured: 0,
        sort_order: 8
      },
      {
        slug: 'penthouse-suites',
        name: 'Penthouse Suites',
        short_description: 'Sky Crown duplex penthouse with private heated rooftop plunge pool, double-height salon, and 360° views.',
        description: 'Floating atop Maison Aurélia, the Sky Crown Duplex Penthouse spans two architectural levels connected by a sculpted Calacatta marble staircase, crowned by a private sky garden and heated infinity plunge pool.',
        base_price: 4950,
        max_adults: 6,
        max_children: 2,
        max_occupancy: 6,
        bed_type: '2 Emperor King Master Suites + 1 Twin Guest Suite',
        size_sqm: 310,
        size_sqft: 3336,
        hero_image: '/images/suite-penthouse.jpg',
        gallery: ['/images/suite-penthouse.jpg', '/images/suite-presidential.jpg', '/images/dining-michelin.jpg', '/images/hero-palace.jpg'],
        amenities: ['Private Heated Rooftop Infinity Plunge Pool', 'Double-Height 6m Glass Atrium Salon', 'Sculpted Calacatta Marble Spiral Staircase', 'Outdoor Sky Fireplace & Chef Teppanyaki Grill', 'Private Wine Vault (40 Grand Cru Selections)', '3 En-Suite Marble Bathrooms + Hammam'],
        facilities: ['Private Rooftop Helipad Transfer Coordination', 'Dedicated Rolls-Royce Chauffeur', 'Exclusive After-Hours Thermal Spa Buyout Option'],
        included_services: ['Private Michelin Chef Dinner for up to 6 Guests (Once per Stay)', '24/7 Dedicated Residence Manager & Butler Team', 'Complimentary Helicopter or Limousine Airport Transfers'],
        is_featured: 1,
        sort_order: 9
      },
      {
        slug: 'accessible-rooms',
        name: 'Accessible Rooms',
        short_description: 'Universal barrier-free luxury suites combining ADA/ISO accessibility with uncompromising five-star aesthetics.',
        description: 'Engineered in collaboration with universal design specialists, our Accessible Luxury Suites provide step-free 120cm wide oak thresholds, motorized drapery and wardrobe rails, visual/tactile alert systems, and a zero-threshold Calacatta marble spa shower.',
        base_price: 520,
        max_adults: 2,
        max_children: 1,
        max_occupancy: 3,
        bed_type: '1 Height-Adjustable Emperor King Bed + Companion Sofa',
        size_sqm: 62,
        size_sqft: 667,
        hero_image: '/images/room-accessible.jpg',
        gallery: ['/images/room-accessible.jpg', '/images/room-deluxe.jpg', '/images/spa-sanctuary.jpg'],
        amenities: ['Zero-Threshold Roll-In Marble Spa Shower with Fold-Down Teak Bench', '180cm Turning Radius Throughout Bedroom & Bath', 'Voice & Tablet Automated Door, Curtain & Lighting Controls', 'Visual Strobe & Bed-Shaker Hearing Support System', 'Lowered Bespoke Vanity, Safe & Minibar', 'Direct Step-Free Elevator Proximity'],
        facilities: ['Hydraulic Pool Lift at Thermal Sanctuary', 'Step-Free Fine Dining & Terrace Access', 'Wheelchair-Accessible Luxury Chauffeur Mercedes V-Class'],
        included_services: ['Priority Curbside Assisted Check-In', '24/7 Dedicated Medical & Mobility Concierge Support', 'Complimentary Companion Breakfast Privilege'],
        is_featured: 0,
        sort_order: 10
      }
    ];

    const insertCategory = db.prepare(`
      INSERT INTO room_categories (
        slug, name, short_description, description, base_price,
        max_adults, max_children, max_occupancy, bed_type,
        size_sqm, size_sqft, hero_image, gallery_json,
        amenities_json, facilities_json, included_services_json,
        check_in_policy, check_out_policy, cancellation_policy, refund_policy,
        is_featured, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const categoryIdBySlug = {};
    for (const c of categories) {
      const res = insertCategory.run(
        c.slug,
        c.name,
        c.short_description,
        c.description,
        c.base_price,
        c.max_adults,
        c.max_children,
        c.max_occupancy,
        c.bed_type,
        c.size_sqm,
        c.size_sqft,
        c.hero_image,
        JSON.stringify(c.gallery),
        JSON.stringify(c.amenities),
        JSON.stringify(c.facilities),
        JSON.stringify(c.included_services),
        defaultPolicies.checkIn,
        defaultPolicies.checkOut,
        defaultPolicies.cancellation,
        defaultPolicies.refund,
        c.is_featured,
        c.sort_order
      );
      categoryIdBySlug[c.slug] = Number(res.lastInsertRowid);
    }

    // 4. Individually Bookable Physical Rooms (16 rooms across all 10 categories)
    const physicalRooms = [
      {
        room_number: '101',
        unique_code: 'AUR-RM-101',
        name: 'Classic Courtyard King #101',
        category_slug: 'standard-rooms',
        floor: 1,
        wing: 'West Heritage Wing',
        view_type: 'Sculpted Limestone Courtyard View',
        price: 420
      },
      {
        room_number: '102',
        unique_code: 'AUR-RM-102',
        name: 'Classic Courtyard King #102',
        category_slug: 'standard-rooms',
        floor: 1,
        wing: 'West Heritage Wing',
        view_type: 'Fountain Courtyard View',
        price: 440
      },
      {
        room_number: '105',
        unique_code: 'AUR-RM-105',
        name: 'Universal Barrier-Free Sanctuary Suite #105',
        category_slug: 'accessible-rooms',
        floor: 1,
        wing: 'Main Palace Wing (Near Grand Lift)',
        view_type: 'Botanical Level-Access Garden View',
        price: 520,
        is_accessible: 1
      },
      {
        room_number: '108',
        unique_code: 'AUR-RM-108',
        name: 'Grand Interconnecting Family Residence #108',
        category_slug: 'family-rooms',
        floor: 1,
        wing: 'East Garden Wing',
        view_type: 'Private Lawn & Cypress Garden View',
        price: 860
      },
      {
        room_number: '109',
        unique_code: 'AUR-RM-109',
        name: 'Royal Interconnecting Family Sanctuary #109',
        category_slug: 'family-rooms',
        floor: 1,
        wing: 'East Garden Wing',
        view_type: 'South Botanical Courtyard View',
        price: 890
      },
      {
        room_number: '201',
        unique_code: 'AUR-RM-201',
        name: 'Deluxe Jasmine Terrace King #201',
        category_slug: 'deluxe-rooms',
        floor: 2,
        wing: 'East Garden Wing',
        view_type: 'Private Jasmine Garden Terrace',
        price: 580
      },
      {
        room_number: '202',
        unique_code: 'AUR-RM-202',
        name: 'Deluxe Magnolia Terrace King #202',
        category_slug: 'deluxe-rooms',
        floor: 2,
        wing: 'East Garden Wing',
        view_type: 'Private Magnolia & Pool Terrace',
        price: 610
      },
      {
        room_number: '205',
        unique_code: 'AUR-RM-205',
        name: 'Superior Waterfront Horizon #205',
        category_slug: 'superior-rooms',
        floor: 2,
        wing: 'Main Palace Wing',
        view_type: 'Panoramic Waterfront Promenade View',
        price: 660
      },
      {
        room_number: '206',
        unique_code: 'AUR-RM-206',
        name: 'Superior Twin Queen Panorama #206',
        category_slug: 'superior-rooms',
        floor: 2,
        wing: 'Main Palace Wing',
        view_type: 'Harbor & Alpine Foothills View',
        price: 680
      },
      {
        room_number: '301',
        unique_code: 'AUR-RM-301',
        name: 'Executive Club Diplomat Chamber #301',
        category_slug: 'executive-rooms',
        floor: 3,
        wing: 'Club Aurélia Wing',
        view_type: 'Elevated Waterfront & Yacht Pier View',
        price: 790
      },
      {
        room_number: '302',
        unique_code: 'AUR-RM-302',
        name: 'Executive Club Ambassador Chamber #302',
        category_slug: 'executive-rooms',
        floor: 3,
        wing: 'Club Aurélia Wing',
        view_type: 'Sunset Bay & Old Town Spire View',
        price: 820
      },
      {
        room_number: '401',
        unique_code: 'AUR-STE-401',
        name: 'Junior Atelier Suite #401',
        category_slug: 'junior-suites',
        floor: 4,
        wing: 'Main Palace Wing',
        view_type: 'Corner Waterfront & Garden Vista',
        price: 980
      },
      {
        room_number: '402',
        unique_code: 'AUR-STE-402',
        name: 'Junior Lumière Corner Suite #402',
        category_slug: 'junior-suites',
        floor: 4,
        wing: 'Main Palace Wing',
        view_type: 'Panoramic Lake & Sunset Balcony',
        price: 1040
      },
      {
        room_number: '501',
        unique_code: 'AUR-STE-501',
        name: 'Grand Aurélia Salon Suite #501',
        category_slug: 'luxury-suites',
        floor: 5,
        wing: 'Noble Heritage Wing',
        view_type: 'Full Waterfront & Reflections Pool View',
        price: 1450
      },
      {
        room_number: '502',
        unique_code: 'AUR-STE-502',
        name: 'Beaux-Arts Royal Parlor Suite #502',
        category_slug: 'luxury-suites',
        floor: 5,
        wing: 'Noble Heritage Wing',
        view_type: 'Grand Esplanade & Marina View',
        price: 1550
      },
      {
        room_number: '701',
        unique_code: 'AUR-PRES-701',
        name: 'The Imperial Presidential Residence #701',
        category_slug: 'presidential-suites',
        floor: 7,
        wing: '7th Floor Private Noble Wing',
        view_type: '270° Unobstructed Waterfront, Coast & Skyline Panorama',
        price: 3800
      },
      {
        room_number: 'PH-01',
        unique_code: 'AUR-PH-01',
        name: 'Sky Crown Duplex Penthouse #PH-01',
        category_slug: 'penthouse-suites',
        floor: 8,
        wing: 'Rooftop Sky Sanctuary (Floors 8–9)',
        view_type: '360° Sky Horizon & Private Rooftop Infinity Pool',
        price: 4950
      }
    ];

    const insertRoom = db.prepare(`
      INSERT INTO rooms (
        room_number, unique_code, name, category_id, floor, wing, view_type,
        price_per_night, max_adults, max_children, max_occupancy, bed_type,
        size_sqm, size_sqft, hero_image, gallery_json, amenities_json,
        facilities_json, included_services_json, check_in_policy, check_out_policy,
        cancellation_policy, refund_policy, is_accessible, is_sample_inventory, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'available')
    `);

    for (const r of physicalRooms) {
      const cat = categories.find((c) => c.slug === r.category_slug);
      const catId = categoryIdBySlug[r.category_slug];
      insertRoom.run(
        r.room_number,
        r.unique_code,
        r.name,
        catId,
        r.floor,
        r.wing,
        r.view_type,
        r.price,
        cat.max_adults,
        cat.max_children,
        cat.max_occupancy,
        cat.bed_type,
        cat.size_sqm,
        cat.size_sqft,
        cat.hero_image,
        JSON.stringify(cat.gallery),
        JSON.stringify(cat.amenities),
        JSON.stringify(cat.facilities),
        JSON.stringify(cat.included_services),
        defaultPolicies.checkIn,
        defaultPolicies.checkOut,
        defaultPolicies.cancellation,
        defaultPolicies.refund,
        r.is_accessible || 0
      );
    }

    // 5. Seasonal Rates
    const insertSeasonal = db.prepare(`
      INSERT INTO seasonal_rates (name, category_id, start_date, end_date, multiplier, badge_text, is_active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `);
    insertSeasonal.run('Festive Gala & New Year Season', null, '2026-12-18', '2027-01-06', 1.25, 'Festive Season (+25%)');
    insertSeasonal.run('Summer Riviera High Season', null, '2027-06-15', '2027-08-31', 1.15, 'Riviera Peak (+15%)');

    // 6. Luxury Extras & Add-ons
    const addons = [
      {
        code: 'CHAUFFEUR_RR',
        name: 'Rolls-Royce Phantom Airport Chauffeur Transfer',
        category: 'Transport',
        description: 'Private VIP meet-and-greet at arrivals with round-trip chauffeur service in our bespoke Rolls-Royce Phantom VIII.',
        price: 280,
        pricing_type: 'per_stay',
        icon: 'car'
      },
      {
        code: 'MICHELIN_BREAKFAST',
        name: 'Le Jardin d’Or Michelin-Curated Daily Breakfast',
        category: 'Dining',
        description: 'Artisanal viennoiseries, Oscietra caviar egg royal, organic cold-pressed elixirs, and barista coffee served in-suite or on the terrace.',
        price: 65,
        pricing_type: 'per_guest_per_night',
        icon: 'coffee'
      },
      {
        code: 'HALF_BOARD_GASTRONOMY',
        name: 'Half-Board Three-Course Sommelier Dinner Plan',
        category: 'Dining',
        description: 'Includes daily breakfast plus a nightly three-course tasting menu at our Michelin-starred restaurant with sommelier wine pairing.',
        price: 195,
        pricing_type: 'per_guest_per_night',
        icon: 'utensils'
      },
      {
        code: 'THERMAL_SPA_RITUAL',
        name: 'Couples 90-Minute Gold Leaf & Thermal Hammam Ritual',
        category: 'Wellness',
        description: 'Private thermal suite reservation with warm volcanic stone massage, 24k gold facial elixir, and herbal champagne infusion.',
        price: 420,
        pricing_type: 'per_stay',
        icon: 'sparkles'
      },
      {
        code: 'HONEYMOON_IMPERIAL',
        name: 'Imperial Romance & Honeymoon Occasion Package',
        category: 'Occasion',
        description: 'Chilled bottle of Dom Pérignon Vintage, 100 long-stem Ecuadorian roses, monogrammed silk pillowcases, and candlelit bath ritual.',
        price: 490,
        pricing_type: 'per_stay',
        icon: 'heart'
      },
      {
        code: 'EXTRA_ROLLAWAY_BED',
        name: 'Bespoke Cashmere Rollaway Bed & Linen Set',
        category: 'Room Comfort',
        description: 'Full-size orthopedic rollaway bed dressed in 600-thread-count Italian linens (for rooms permitting an additional guest).',
        price: 95,
        pricing_type: 'per_night',
        icon: 'bed'
      }
    ];

    const insertAddon = db.prepare(`
      INSERT INTO addons (code, name, category, description, price, pricing_type, icon, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `);
    for (const a of addons) {
      insertAddon.run(a.code, a.name, a.category, a.description, a.price, a.pricing_type, a.icon);
    }

    // 7. Promotional Codes
    const promos = [
      {
        code: 'AURELIA10',
        description: '10% Privilege Reduction on Direct Online Reservations',
        discount_type: 'percent',
        discount_value: 10,
        min_nights: 1,
        min_amount: 300,
        valid_from: '2026-01-01',
        valid_until: '2027-12-31'
      },
      {
        code: 'ROYALSUITE15',
        description: '15% Sanctuary Suite Escape (Minimum 2 Nights)',
        discount_type: 'percent',
        discount_value: 15,
        min_nights: 2,
        min_amount: 800,
        valid_from: '2026-01-01',
        valid_until: '2027-12-31'
      },
      {
        code: 'HONEYMOON250',
        description: '$250 Complimentary Credit on Luxury Stays over $1,500',
        discount_type: 'fixed',
        discount_value: 250,
        min_nights: 2,
        min_amount: 1500,
        valid_from: '2026-01-01',
        valid_until: '2027-12-31'
      }
    ];

    const insertPromo = db.prepare(`
      INSERT INTO promo_codes (code, description, discount_type, discount_value, min_nights, min_amount, valid_from, valid_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const p of promos) {
      insertPromo.run(p.code, p.description, p.discount_type, p.discount_value, p.min_nights, p.min_amount, p.valid_from, p.valid_until);
    }

    // 8. Notification Templates
    const templates = [
      {
        code: 'BOOKING_CONFIRMED',
        name: 'Reservation Confirmation & Pre-Arrival Dossier',
        channel: 'both',
        subject_template: 'Maison Aurélia — Confirmed Reservation {{booking_reference}} ({{check_in}} to {{check_out}})',
        body_template: 'Dear {{guest_name}},\n\nIt is our distinct privilege to confirm your reservation at Maison Aurélia Grand Palace & Sanctuary.\n\nBooking Reference: {{booking_reference}}\nSuite / Room: {{room_summary}}\nCheck-In: {{check_in}} (from 15:00)\nCheck-Out: {{check_out}} (until 12:00)\nTotal Stay Amount: {{total_formatted}}\nPayment Status: {{payment_status}}\n\nOur Head Concierge remains at your disposal prior to arrival.\n\nWarmest regards,\nMaison Aurélia Private Concierge'
      },
      {
        code: 'PAYMENT_RECEIPT',
        name: 'Official Payment Verification & Tax Invoice Receipt',
        channel: 'email',
        subject_template: 'Maison Aurélia — Official Payment Receipt {{invoice_number}} for {{booking_reference}}',
        body_template: 'Dear {{guest_name}},\n\nWe confirm receipt of your payment for reservation {{booking_reference}}.\n\nInvoice Number: {{invoice_number}}\nPayment Reference: {{payment_reference}}\nAmount Verified: {{amount_formatted}}\nPayment Method: {{payment_method}}\n\nThank you for choosing Maison Aurélia.'
      },
      {
        code: 'BOOKING_CANCELLED',
        name: 'Reservation Cancellation & Refund Notice',
        channel: 'both',
        subject_template: 'Maison Aurélia — Cancellation Confirmation for Reservation {{booking_reference}}',
        body_template: 'Dear {{guest_name}},\n\nYour reservation {{booking_reference}} ({{check_in}} to {{check_out}}) has been cancelled in accordance with your request.\n\nRefund Amount Issued: {{refund_formatted}}\nReason: {{cancellation_reason}}\n\nWe hope to welcome you back to Maison Aurélia in the future.'
      },
      {
        code: 'REFUND_PROCESSED',
        name: 'Refund Dispatched Notification',
        channel: 'email',
        subject_template: 'Maison Aurélia — Refund Processed for {{booking_reference}}',
        body_template: 'Dear {{guest_name}},\n\nA refund of {{refund_formatted}} has been processed for reservation {{booking_reference}} (Reference: {{payment_reference}}).'
      }
    ];

    const insertTemplate = db.prepare(`
      INSERT INTO notification_templates (code, name, channel, subject_template, body_template, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
    `);
    for (const t of templates) {
      insertTemplate.run(t.code, t.name, t.channel, t.subject_template, t.body_template);
    }

    // 8. Seed Initial Guest-to-Admin Messaging Inbox Thread
    const guestUser = db.prepare("SELECT id FROM users WHERE email = 'elena.rostova@example.com'").get();
    const adminUser = db.prepare("SELECT id FROM users WHERE email = 'admin@maisonaurelia.luxury'").get();
    const threadRes = db.prepare(`
      INSERT INTO message_threads (
        thread_reference, user_id, guest_name, guest_email, booking_reference,
        department, subject, status, priority, unread_by_admin, unread_by_guest
      ) VALUES (
        'MSG-VIP001', ?, 'Elena Rostova', 'elena.rostova@example.com', 'AUR-2026-PRES01',
        'Head Concierge & Admin', 'Private Helipad Arrival & Vintage Krug Pairing Inquiry',
        'awaiting_staff', 'vip_urgent', 1, 0
      )
    `).run(guestUser ? guestUser.id : null);

    const seededThreadId = Number(threadRes.lastInsertRowid);
    const insMsg = db.prepare(`
      INSERT INTO thread_messages (thread_id, sender_user_id, sender_role, sender_name, sender_email, body, is_read)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insMsg.run(
      seededThreadId,
      guestUser ? guestUser.id : null,
      'guest',
      'Elena Rostova',
      'elena.rostova@example.com',
      'Bonjour Henri, we will be arriving via helicopter from Zurich at 15:30. Could you confirm our rooftop helipad clearance and arrange two glasses of chilled Krug Grande Cuvée in the Presidential Suite?',
      1
    );
    insMsg.run(
      seededThreadId,
      adminUser ? adminUser.id : null,
      'admin',
      'Henri de Valois (Palace Director)',
      'admin@maisonaurelia.luxury',
      'Madame Rostova, our rooftop helipad is reserved for your 15:30 touch-down and our Head Butler has already placed a bottle of Krug Grande Cuvée on ice in Suite #701.',
      1
    );
    insMsg.run(
      seededThreadId,
      guestUser ? guestUser.id : null,
      'guest',
      'Elena Rostova',
      'elena.rostova@example.com',
      'Wonderful! May we also request a 20:00 corner table by the fountain at Le Jardin d’Or for our first evening?',
      0
    );

    return { seeded: true, categoriesCount: categories.length, roomsCount: physicalRooms.length };
  });
}

module.exports = { seedDatabase };
