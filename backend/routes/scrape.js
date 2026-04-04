const express = require('express');
const router = express.Router();
const db = require('../db');

let scrapeInProgress = false;

// GET /api/scrape/status
router.get('/status', async (req, res) => {
  try {
    const rows = await db.getScrapeStatus();
    const [dogCount, catCount] = await Promise.all([
      db.getProductCount('dog'),
      db.getProductCount('cat')
    ]);

    const status = {};
    rows.forEach(row => { status[row.category] = row; });

    res.json({
      scrapeInProgress,
      dog: {
        ...status.dog,
        productCount: dogCount
      },
      cat: {
        ...status.cat,
        productCount: catCount
      }
    });
  } catch (err) {
    console.error('[API] /api/scrape/status error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/scrape/trigger?category=dog|cat|all
router.post('/trigger', async (req, res) => {
  if (scrapeInProgress) {
    return res.status(409).json({ error: 'Scrape already in progress' });
  }

  const category = req.query.category || 'all';
  if (!['dog', 'cat', 'all'].includes(category)) {
    return res.status(400).json({ error: 'category must be dog, cat, or all' });
  }

  res.json({ status: 'started', category });

  // Run asynchronously after response
  scrapeInProgress = true;
  const { scrapeCategory, scrapeAll } = require('../scraper');

  const run = category === 'all' ? scrapeAll() : scrapeCategory(category);
  run
    .then(() => { scrapeInProgress = false; })
    .catch(err => {
      console.error('[Scrape trigger] Error:', err.message);
      scrapeInProgress = false;
    });
});

module.exports = { router, setScrapeInProgress: (v) => { scrapeInProgress = v; } };
