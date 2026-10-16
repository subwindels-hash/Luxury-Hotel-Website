const { initDatabase, backupDatabase } = require('../db/database');
const { seedDatabase } = require('../db/seed');

initDatabase();
seedDatabase();
const result = backupDatabase();
console.log(JSON.stringify({ status: 'backup_complete', ...result }, null, 2));
