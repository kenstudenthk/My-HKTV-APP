const axios = require('axios');
const db = require('./db');

const CATE_SEARCH_API_URL = 'https://cate-search.hktvmall.com/query/products';
const BASE_URL = 'https://www.hktvmall.com/hktv/zh/';
const PAGE_SIZE = 60;
const REQUEST_DELAY_MS = 500;
const MAX_PAGES = 250;
const MAX_RETRIES = 4;

const CATEGORIES = {
  dog: {
    name: 'dog',
    label: '狗糧',
    query: ':relevance:category:AA83100510000:zone:pets:street:main:'
  },
  cat: {
    name: 'cat',
    label: '貓糧',
    query: ':relevance:category:AA83200510000:zone:pets:street:main:'
  }
};

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://www.hktvmall.com',
  'Referer': 'https://www.hktvmall.com/'
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeFloat(obj, key = 'value') {
  if (!obj) return null;
  const val = obj[key];
  if (val === undefined || val === null) return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

function mapProduct(raw, categoryName) {
  // Extract prices from priceList (BUY = original, DISCOUNT = sale)
  const priceList = raw.priceList || [];
  let originalPrice = null;
  let salePrice = null;

  for (const entry of priceList) {
    if (entry.priceType === 'BUY') originalPrice = parseFloat(entry.value) || null;
    if (entry.priceType === 'DISCOUNT') salePrice = parseFloat(entry.value) || null;
  }

  // Fallback to top-level price fields if priceList is missing
  if (originalPrice === null) originalPrice = safeFloat(raw.price);
  if (salePrice === null) salePrice = safeFloat(raw.promotionPrice);

  if (!originalPrice || !salePrice) return null;
  if (salePrice >= originalPrice) return null; // no discount

  const discountRate = Math.round((1 - salePrice / originalPrice) * 100);

  // Image URL
  let imageUrl = null;
  const images = raw.images || [];
  if (images.length > 0) {
    const img = images[0].url || '';
    imageUrl = img.startsWith('//') ? 'https:' + img : img;
  }

  // Product URL
  let productUrl = raw.url || '';
  if (productUrl && !productUrl.startsWith('http')) {
    productUrl = BASE_URL + productUrl.replace(/^\//, '');
  }

  // Stock status
  const stockCode = raw.stock?.stockLevelStatus?.code || '';
  const inStock = stockCode === 'inStock' ? 1 : 0;

  return {
    product_id: raw.code || '',
    category: categoryName,
    name: raw.name || '(unknown)',
    brand: raw.brandName || null,
    original_price: originalPrice,
    discount_price: salePrice,
    discount_rate: discountRate,
    in_stock: inStock,
    image_url: imageUrl,
    product_url: productUrl
  };
}

async function scrapeCategory(categoryKey) {
  const categoryConfig = CATEGORIES[categoryKey];
  if (!categoryConfig) throw new Error(`Unknown category: ${categoryKey}`);

  const { name: categoryName, label, query } = categoryConfig;

  console.log(`\n[Scraper] === Starting scrape for ${label} (${categoryName}) ===`);

  await db.updateScrapeProgress(categoryName, {
    status: 'running',
    started_at: new Date().toISOString(),
    completed_at: null
  });

  let pageNo = 0;
  let totalPages = null;
  let totalProducts = 0;
  let retryCount = 0;

  while (true) {
    if (pageNo >= MAX_PAGES) {
      console.log(`[Scraper] Reached MAX_PAGES (${MAX_PAGES}), stopping.`);
      break;
    }

    let response;
    try {
      response = await axios.post(
        CATE_SEARCH_API_URL,
        null,
        {
          params: {
            query,
            currentPage: pageNo,
            pageSize: PAGE_SIZE
          },
          headers: HTTP_HEADERS,
          timeout: 30000
        }
      );
      retryCount = 0;
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 || status === 503) {
        const waitMs = Math.min(Math.pow(2, retryCount) * 2000, 60000);
        console.log(`[Scraper] Rate limited (${status}). Waiting ${waitMs / 1000}s...`);
        await sleep(waitMs);
        retryCount++;
        if (retryCount > MAX_RETRIES) {
          console.error('[Scraper] Too many retries. Stopping.');
          break;
        }
        continue;
      }
      console.error(`[Scraper] Request failed on page ${pageNo}: ${err.message}`);
      break;
    }

    const data = response.data;
    const products = data.products || [];

    if (products.length === 0) {
      console.log(`[Scraper] No products on page ${pageNo}. Stopping.`);
      break;
    }

    // On first page, read total pages from pagination
    if (pageNo === 0) {
      const pagination = data.pagination || {};
      totalPages = Math.min(pagination.numberOfPages || 1, MAX_PAGES);
      const totalResults = pagination.totalNumberOfResults || 0;
      console.log(`[Scraper] Total pages: ${totalPages}, Total results: ${totalResults}`);
      await db.updateScrapeProgress(categoryName, { total_pages: totalPages });
    }

    const mapped = products
      .map(p => mapProduct(p, categoryName))
      .filter(Boolean);

    if (mapped.length > 0) {
      await db.upsertProducts(mapped);
    }

    totalProducts += mapped.length;

    await db.updateScrapeProgress(categoryName, {
      last_page_scraped: pageNo,
      total_products: totalProducts
    });

    console.log(`[Scraper] Page ${pageNo + 1}/${totalPages} — ${mapped.length} deals saved (total: ${totalProducts})`);

    pageNo++;
    if (totalPages !== null && pageNo >= totalPages) break;

    await sleep(REQUEST_DELAY_MS);
  }

  await db.updateScrapeProgress(categoryName, {
    status: 'complete',
    completed_at: new Date().toISOString(),
    total_products: totalProducts
  });

  console.log(`[Scraper] === Finished ${label}: ${totalProducts} deals total ===\n`);
  return totalProducts;
}

async function scrapeAll() {
  await scrapeCategory('dog');
  await scrapeCategory('cat');
}

module.exports = { scrapeCategory, scrapeAll };
