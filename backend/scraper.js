const { chromium } = require('playwright');
const axios = require('axios');
const db = require('./db');

const CATEGORIES = {
  dog: {
    name: 'dog',
    label: '狗糧',
    url: 'https://www.hktvmall.com/hktv/zh/%E5%AF%B5%E7%89%A9%E7%94%A8%E5%93%81/%E7%8B%97%E7%8B%97%E5%B0%88%E5%8D%80/%E7%8B%97%E9%A3%9F%E5%93%81/main/search?q=%3Arelevance%3Astreet%3Amain%3Acategory%3AAA83100500000',
    categoryFilter: 'AA83100500000'
  },
  cat: {
    name: 'cat',
    label: '貓糧',
    url: 'https://www.hktvmall.com/hktv/zh/%E5%AF%B5%E7%89%A9%E7%94%A8%E5%93%81/%E8%B2%93%E8%B2%93%E5%B0%88%E5%8D%80/%E8%B2%93%E9%A3%9F%E5%93%81/main/search?q=%3Arelevance%3Astreet%3Amain%3Acategory%3AAA83100000000',
    categoryFilter: 'AA83100000000'
  }
};

const HITS_PER_PAGE = 60;
const REQUEST_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function extractAlgoliaConfig(categoryUrl) {
  console.log('[Scraper] Launching browser to extract Algolia config...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.setExtraHTTPHeaders({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  let algoliaConfig = null;
  let algoliaRequestBody = null;

  page.on('request', request => {
    const url = request.url();
    if (url.includes('algolia.net') && url.includes('/queries')) {
      const headers = request.headers();
      const appId = headers['x-algolia-application-id'];
      const apiKey = headers['x-algolia-api-key'];
      if (appId && apiKey) {
        algoliaConfig = { appId, apiKey, queryUrl: url };
        try {
          const rawBody = request.postData();
          if (rawBody) algoliaRequestBody = JSON.parse(rawBody);
        } catch (_) {}
      }
    }
  });

  try {
    await page.goto(categoryUrl, { waitUntil: 'networkidle', timeout: 60000 });
  } catch (e) {
    console.log('[Scraper] Page load timeout (normal) — checking if config was captured...');
  }

  // Wait a bit more for XHR calls to fire if networkidle didn't catch them
  if (!algoliaConfig) {
    await sleep(5000);
  }

  await browser.close();

  if (!algoliaConfig) {
    throw new Error('Could not extract Algolia config from the page. The site may have changed.');
  }

  console.log(`[Scraper] Algolia config extracted. AppId: ${algoliaConfig.appId}`);
  return { algoliaConfig, algoliaRequestBody };
}

function buildAlgoliaQuery(algoliaRequestBody, pageNo) {
  if (algoliaRequestBody && algoliaRequestBody.requests && algoliaRequestBody.requests.length > 0) {
    // Clone the original request body and update the page number
    const cloned = JSON.parse(JSON.stringify(algoliaRequestBody));
    cloned.requests.forEach(req => {
      const params = new URLSearchParams(req.params || '');
      params.set('page', String(pageNo));
      params.set('hitsPerPage', String(HITS_PER_PAGE));
      req.params = params.toString();
    });
    return cloned;
  }
  // Fallback: should not happen, but just in case
  return null;
}

function mapHitToProduct(hit, categoryName) {
  const originalPrice = hit.price?.HKD?.value ?? hit.originalPrice ?? null;
  const discountPrice = hit.salePrice?.HKD?.value ?? hit.discountPrice ?? originalPrice;
  const discountRate = (originalPrice && discountPrice && discountPrice < originalPrice)
    ? Math.round((1 - discountPrice / originalPrice) * 100)
    : 0;

  // Build the product URL from objectID or slug
  const objectID = hit.objectID || hit.code || '';
  const productUrl = hit.url
    ? (hit.url.startsWith('http') ? hit.url : `https://www.hktvmall.com${hit.url}`)
    : `https://www.hktvmall.com/hktv/zh/main/${objectID}/p/${objectID}`;

  // Get image URL
  const imageUrl = hit.images?.[0]?.url
    ?? hit.thumbnail
    ?? hit.image
    ?? (hit.images && typeof hit.images === 'string' ? hit.images : null)
    ?? null;

  // Stock status: Algolia sometimes has stock info
  const inStock = hit.inStock !== undefined
    ? (hit.inStock ? 1 : 0)
    : (hit.stockLevel !== undefined ? (hit.stockLevel > 0 ? 1 : 0) : 1);

  return {
    product_id: objectID,
    category: categoryName,
    name: hit.name || hit.title || hit.productName || '(unknown)',
    brand: hit.brand || hit.brandName || null,
    original_price: originalPrice,
    discount_price: discountPrice,
    discount_rate: discountRate,
    in_stock: inStock,
    image_url: imageUrl,
    product_url: productUrl
  };
}

async function scrapeCategory(categoryKey) {
  const categoryConfig = CATEGORIES[categoryKey];
  if (!categoryConfig) throw new Error(`Unknown category: ${categoryKey}`);

  const { name: categoryName, label, url: categoryUrl } = categoryConfig;

  console.log(`\n[Scraper] === Starting scrape for ${label} (${categoryName}) ===`);

  // Mark as running
  await db.updateScrapeProgress(categoryName, {
    status: 'running',
    started_at: new Date().toISOString(),
    completed_at: null
  });

  // Check for resumable progress
  const statusRows = await db.getScrapeStatus();
  const existing = statusRows.find(r => r.category === categoryName);
  let startPage = 0;
  if (existing && existing.status === 'running' && existing.last_page_scraped >= 0) {
    startPage = existing.last_page_scraped + 1;
    console.log(`[Scraper] Resuming from page ${startPage}`);
  }

  // Phase 1: Extract Algolia config via Playwright
  let algoliaConfig, algoliaRequestBody;
  try {
    ({ algoliaConfig, algoliaRequestBody } = await extractAlgoliaConfig(categoryUrl));
  } catch (err) {
    console.error(`[Scraper] Failed to extract Algolia config: ${err.message}`);
    await db.updateScrapeProgress(categoryName, { status: 'error' });
    throw err;
  }

  if (!algoliaRequestBody) {
    console.error('[Scraper] No Algolia request body captured. Cannot proceed with HTTP scraping.');
    await db.updateScrapeProgress(categoryName, { status: 'error' });
    throw new Error('No Algolia request body captured');
  }

  // Phase 2: HTTP pagination loop
  let pageNo = startPage;
  let totalPages = Infinity;
  let totalProducts = existing ? (existing.total_products || 0) : 0;
  let retryCount = 0;
  const MAX_RETRIES = 4;

  while (pageNo < totalPages) {
    const queryBody = buildAlgoliaQuery(algoliaRequestBody, pageNo);
    if (!queryBody) {
      console.error('[Scraper] Could not build Algolia query body');
      break;
    }

    let response;
    try {
      response = await axios.post(
        algoliaConfig.queryUrl,
        queryBody,
        {
          headers: {
            'X-Algolia-Application-Id': algoliaConfig.appId,
            'X-Algolia-API-Key': algoliaConfig.apiKey,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
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

    const result = response.data?.results?.[0];
    if (!result) {
      console.log(`[Scraper] No results on page ${pageNo}. Stopping.`);
      break;
    }

    const { hits = [], nbPages = 1, nbHits } = result;

    if (pageNo === startPage) {
      totalPages = nbPages;
      console.log(`[Scraper] Total pages: ${totalPages}, Total products: ${nbHits}`);
      await db.updateScrapeProgress(categoryName, { total_pages: totalPages });
    }

    if (hits.length === 0) {
      console.log(`[Scraper] Empty hits on page ${pageNo}. Stopping.`);
      break;
    }

    const products = hits.map(hit => mapHitToProduct(hit, categoryName));
    await db.upsertProducts(products);
    totalProducts += products.length;

    await db.updateScrapeProgress(categoryName, {
      last_page_scraped: pageNo,
      total_products: totalProducts
    });

    console.log(`[Scraper] Page ${pageNo + 1}/${totalPages} — ${products.length} products saved (total: ${totalProducts})`);

    pageNo++;
    if (pageNo < totalPages) await sleep(REQUEST_DELAY_MS);
  }

  await db.updateScrapeProgress(categoryName, {
    status: 'complete',
    completed_at: new Date().toISOString(),
    total_products: totalProducts
  });

  console.log(`[Scraper] === Finished ${label}: ${totalProducts} products total ===\n`);
  return totalProducts;
}

async function scrapeAll() {
  await scrapeCategory('dog');
  await scrapeCategory('cat');
}

module.exports = { scrapeCategory, scrapeAll };
