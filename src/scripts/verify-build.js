const fs = require('node:fs');
const path = require('node:path');
const { initDatabase } = require('../db/database');
const { seedDatabase } = require('../db/seed');

const requiredFiles = [
  'src/server.js',
  'src/app.js',
  'src/db/database.js',
  'src/db/seed.js',
  'src/services/availabilityService.js',
  'src/services/bookingService.js',
  'src/services/paymentService.js',
  'src/routes/api.js',
  'public/index.html',
  'public/css/styles.css',
  'public/js/i18n.js',
  'public/js/app.js'
];

for (const rel of requiredFiles) {
  const full = path.join(__dirname, '..', '..', rel);
  if (!fs.existsSync(full)) {
    console.error(`Build verification failed: missing ${rel}`);
    process.exit(1);
  }
}

const db = initDatabase(':memory:');
const seeded = seedDatabase(db);
if (!seeded.seeded || seeded.categoriesCount < 10) {
  console.error('Build verification failed: database seed check failed');
  process.exit(1);
}

console.log(
  JSON.stringify({
    status: 'production_build_verified',
    categoriesSeeded: seeded.categoriesCount,
    roomsSeeded: seeded.roomsCount,
    timestamp: new Date().toISOString()
  })
);
