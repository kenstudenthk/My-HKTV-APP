const cron = require('node-cron');
const { updateData } = require('./scraper');
cron.schedule('0 */6 * * *', updateData); // Every 6 hours
console.log('Cron job scheduled');