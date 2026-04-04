const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/products
// Query params: category, page, pageSize, minDiscount, maxDiscount, minPrice, maxPrice, keyword, brand, inStockOnly, sort
router.get('/', async (req, res) => {
  try {
    const {
      category,
      page = 0,
      pageSize = 24,
      minDiscount = 0,
      maxDiscount,
      minPrice,
      maxPrice,
      keyword,
      brand,
      inStockOnly,
      sort = 'priceAsc'
    } = req.query;

    if (!category) {
      return res.status(400).json({ error: 'category is required (dog or cat)' });
    }

    const result = await db.getProducts({
      category,
      page,
      pageSize: Math.min(Number(pageSize), 100),
      minDiscount,
      maxDiscount,
      minPrice,
      maxPrice,
      keyword,
      brand,
      inStockOnly,
      sort
    });

    const totalPages = Math.ceil(result.total / result.pageSize);

    res.json({
      products: result.products,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages
    });
  } catch (err) {
    console.error('[API] /api/products error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/products/brands?category=dog
router.get('/brands', async (req, res) => {
  try {
    const { category } = req.query;
    if (!category) return res.status(400).json({ error: 'category is required' });
    const brands = await db.getBrands(category);
    res.json(brands);
  } catch (err) {
    console.error('[API] /api/products/brands error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/products/stats?category=dog
router.get('/stats', async (req, res) => {
  try {
    const { category } = req.query;
    if (!category) return res.status(400).json({ error: 'category is required' });
    const stats = await db.getStats(category);
    res.json(stats);
  } catch (err) {
    console.error('[API] /api/products/stats error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
