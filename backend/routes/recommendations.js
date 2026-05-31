const express = require('express');
const router = express.Router();
const db = require('../db');

const USER_ID_RE = /^[a-zA-Z0-9_-]{8,80}$/;
const FEEDBACK_RATINGS = new Set(['satisfied', 'unsatisfied', 'skip']);

function validUserId(userId) {
  return typeof userId === 'string' && USER_ID_RE.test(userId);
}

function normalizeProductSnapshot(body) {
  return {
    user_id: body.user_id,
    event_type: body.event_type,
    product_id: body.product_id,
    name: body.name,
    brand: body.brand,
    category: body.category,
    weight_grams: body.weight_grams,
    discount_price: body.discount_price,
    original_price: body.original_price,
    discount_rate: body.discount_rate,
    in_stock: body.in_stock
  };
}

function netInterests(events) {
  const map = new Map();
  events.forEach(event => {
    if (event.event_type === 'add') map.set(event.product_id, event);
    if (event.event_type === 'remove') map.delete(event.product_id);
  });
  return [...map.values()];
}

function average(values) {
  const nums = values.filter(value => Number.isFinite(Number(value))).map(Number);
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function topCounts(values) {
  const counts = new Map();
  values.filter(Boolean).forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
  return counts;
}

function buildProfile(interests) {
  return {
    brands: topCounts(interests.map(item => item.brand)),
    categories: topCounts(interests.map(item => item.category)),
    avgPrice: average(interests.map(item => item.discount_price)),
    avgWeight: average(interests.map(item => item.weight_grams))
  };
}

function closenessBoost(value, target, maxBoost) {
  if (!Number.isFinite(Number(value)) || !Number.isFinite(Number(target)) || target <= 0) return 0;
  const diffRatio = Math.abs(Number(value) - Number(target)) / target;
  return Math.max(0, maxBoost * (1 - Math.min(diffRatio, 1)));
}

function reasonFor(product, profile, isColdStart) {
  if (isColdStart) {
    return `High-discount ${product.category === 'dog' ? 'dog' : 'cat'} food deal available now.`;
  }
  if (product.brand && profile.brands.has(product.brand)) {
    return `Matches a brand you saved, with ${product.discount_rate || 0}% off.`;
  }
  if (product.category && profile.categories.has(product.category)) {
    return `Same pet category as your interests and currently discounted.`;
  }
  if (profile.avgWeight && product.weight_grams) {
    return `Similar package size to products you saved.`;
  }
  return `Good current value based on your saved interests.`;
}

function scoreProduct(product, profile, favouriteIds, isColdStart) {
  let score = 0;
  if (product.in_stock === 1) score += 20;
  score += Math.min(Number(product.discount_rate || 0), 80) * 0.8;

  if (isColdStart) return score;

  if (product.brand && profile.brands.has(product.brand)) {
    score += 35 + profile.brands.get(product.brand) * 5;
  }
  if (product.category && profile.categories.has(product.category)) {
    score += 25 + profile.categories.get(product.category) * 4;
  }
  score += closenessBoost(product.discount_price, profile.avgPrice, 20);
  score += closenessBoost(product.weight_grams, profile.avgWeight, 18);
  if (favouriteIds.has(product.product_id)) score -= 80;
  return score;
}

router.get('/favourites', async (req, res) => {
  try {
    const { user_id: userId } = req.query;
    if (!validUserId(userId)) return res.status(400).json({ error: 'valid user_id is required' });
    const product_ids = await db.getFavouriteIds(userId);
    res.json({ product_ids });
  } catch (err) {
    console.error('[API] /api/favourites error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/interests', async (req, res) => {
  try {
    const body = normalizeProductSnapshot(req.body || {});
    if (!validUserId(body.user_id)) return res.status(400).json({ error: 'valid user_id is required' });
    if (!['add', 'remove'].includes(body.event_type)) return res.status(400).json({ error: 'event_type must be add or remove' });
    if (!body.product_id) return res.status(400).json({ error: 'product_id is required' });

    await db.recordInterestEvent(body);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] /api/interests error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/recommendations', async (req, res) => {
  try {
    const { user_id: userId } = req.query;
    if (!validUserId(userId)) return res.status(400).json({ error: 'valid user_id is required' });

    const view = await db.incrementRecommendationView(userId);
    const events = await db.getInterestEvents(userId);
    const interests = netInterests(events);
    const favouriteIds = new Set(interests.map(item => item.product_id));
    const isColdStart = interests.length < 3;
    const profile = buildProfile(interests);
    const candidates = await db.getRecommendationCandidates();

    const items = candidates
      .map(product => ({
        ...product,
        score: scoreProduct(product, profile, favouriteIds, isColdStart),
        reason: reasonFor(product, profile, isColdStart)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 24)
      .map(({ score, ...product }) => product);

    res.json({
      cold_start: isColdStart,
      generated_at: new Date().toISOString(),
      view_count: view.view_count || 0,
      show_feedback_prompt: (view.view_count || 0) > 0 && (view.view_count || 0) % 3 === 0,
      items
    });
  } catch (err) {
    console.error('[API] /api/recommendations error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/recommendation-feedback', async (req, res) => {
  try {
    const { user_id: userId, rating, view_count: viewCount } = req.body || {};
    if (!validUserId(userId)) return res.status(400).json({ error: 'valid user_id is required' });
    if (!FEEDBACK_RATINGS.has(rating)) return res.status(400).json({ error: 'invalid rating' });

    await db.recordRecommendationFeedback(userId, rating, viewCount);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] /api/recommendation-feedback error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
