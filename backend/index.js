const express = require('express');
const path = require('path');
const cron = require('node-cron');
const db = require('./db');
const productsRouter = require('./routes/products');
const { router: scrapeRouter, setScrapeInProgress } = require('./routes/scrape');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../frontend')));

// API routes
app.use('/api/products', productsRouter);
app.use('/api/scrape', scrapeRouter);

// Catch-all: serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Initialise DB then start server
db.initialize()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[Server] Running on http://localhost:${PORT}`);
    });

    // Schedule scrape every 6 hours
    cron.schedule('0 */6 * * *', async () => {
      console.log('[Cron] Starting scheduled scrape (every 6 hours)...');
      setScrapeInProgress(true);
      const { scrapeAll } = require('./scraper');
      try {
        await scrapeAll();
      } catch (err) {
        console.error('[Cron] Scrape error:', err.message);
      } finally {
        setScrapeInProgress(false);
      }
    });

    console.log('[Cron] Scheduled scrape every 6 hours');
  })
  .catch(err => {
    console.error('[Server] Failed to initialize database:', err.message);
    process.exit(1);
  });
