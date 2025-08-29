// Main entry point for the application
// This starts the Express server and schedules the cron job for data updates

const express = require('express');
const path = require('path');
const cron = require('node-cron');
const { updateData } = require('./scraper');

// Import and set up the Express app
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(path.join(__dirname, 'products.db')); // Adjust path if needed

const app = express();
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files (e.g., images)

// Serve frontend statically (access at http://localhost:3000/)
app.use(express.static(path.join(__dirname, '../frontend')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

// API Endpoint
app.get('/api/products', (req, res) => {
  const { category, page = 0, pageSize = 20, minDiscount = 0, minPrice, maxPrice, keyword, sort } = req.query;
  let sql = `SELECT * FROM products WHERE category = ? AND discountRate >= ?`;
  let params = [category, minDiscount];
  if (minPrice) { sql += ' AND discountPrice >= ?'; params.push(minPrice); }
  if (maxPrice) { sql += ' AND discountPrice <= ?'; params.push(maxPrice); }
  if (keyword) { sql += ' AND (name LIKE ? OR description LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }
  if (sort === 'priceAsc') sql += ' ORDER BY discountPrice ASC';
  else if (sort === 'discountDesc') sql += ' ORDER BY discountRate DESC';
  else if (sort === 'latest') sql += ' ORDER BY id DESC'; // Assuming id as proxy for latest
  sql += ` LIMIT ? OFFSET ?`;
  params.push(pageSize, page * pageSize);

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err });
    res.json(rows);
  });
});

// Start server
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Schedule cron job for updates every 6 hours
cron.schedule('0 */6 * * *', () => {
  console.log('Running scheduled data update...');
  updateData();
});
console.log('Cron job scheduled for every 6 hours');