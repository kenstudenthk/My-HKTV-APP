const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'products.db');
const WEIGHT_PARSER_VERSION = '3';

let db;

function getDb() {
  if (!db) {
    db = new sqlite3.Database(DB_PATH);
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA synchronous = NORMAL');
  }
  return db;
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function addColumnIfMissing(database, table, column, definition) {
  database.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, (err) => {
    if (err && !String(err.message).includes('duplicate column name')) {
      console.error(`Failed to add ${column} column:`, err.message);
    }
  });
}

function initialize() {
  return new Promise((resolve, reject) => {
    const database = getDb();
    database.serialize(() => {
      database.run(`
        CREATE TABLE IF NOT EXISTS products (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          product_id TEXT UNIQUE,
          category TEXT NOT NULL,
          name TEXT NOT NULL,
          brand TEXT,
          original_price REAL,
          discount_price REAL,
          discount_rate INTEGER DEFAULT 0,
          weight_grams REAL,
          in_stock INTEGER DEFAULT 1,
          image_url TEXT,
          product_url TEXT,
          scraped_at TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      addColumnIfMissing(database, 'products', 'brand', 'TEXT');
      addColumnIfMissing(database, 'products', 'original_price', 'REAL');
      addColumnIfMissing(database, 'products', 'discount_price', 'REAL');
      addColumnIfMissing(database, 'products', 'discount_rate', 'INTEGER DEFAULT 0');
      addColumnIfMissing(database, 'products', 'weight_grams', 'REAL');
      addColumnIfMissing(database, 'products', 'in_stock', 'INTEGER DEFAULT 1');
      addColumnIfMissing(database, 'products', 'image_url', 'TEXT');
      addColumnIfMissing(database, 'products', 'product_url', 'TEXT');
      addColumnIfMissing(database, 'products', 'scraped_at', 'TEXT');

      database.run(`CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)`);
      database.run(`CREATE INDEX IF NOT EXISTS idx_products_discount_rate ON products(discount_rate)`);
      database.run(`CREATE INDEX IF NOT EXISTS idx_products_discount_price ON products(discount_price)`);
      database.run(`CREATE INDEX IF NOT EXISTS idx_products_weight_grams ON products(weight_grams)`);
      database.run(`CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand)`);
      database.run(`CREATE INDEX IF NOT EXISTS idx_products_in_stock ON products(in_stock)`);
      database.run(`
        CREATE TABLE IF NOT EXISTS app_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);

      database.run(`
        CREATE TABLE IF NOT EXISTS scrape_progress (
          category TEXT PRIMARY KEY,
          last_page_scraped INTEGER DEFAULT -1,
          total_pages INTEGER DEFAULT 0,
          total_products INTEGER DEFAULT 0,
          started_at TEXT,
          completed_at TEXT,
          status TEXT DEFAULT 'idle'
        )
      `, (err) => {
        if (err) return reject(err);

        database.exec(`
          CREATE TABLE IF NOT EXISTS rec_users (
            user_id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS interest_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            product_id TEXT NOT NULL,
            name TEXT,
            brand TEXT,
            category TEXT,
            weight_grams REAL,
            discount_price REAL,
            original_price REAL,
            discount_rate INTEGER,
            in_stock INTEGER,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_interest_events_user ON interest_events(user_id, created_at);
          CREATE TABLE IF NOT EXISTS recommendation_views (
            user_id TEXT PRIMARY KEY,
            view_count INTEGER NOT NULL DEFAULT 0,
            last_feedback_at TEXT
          );
          CREATE TABLE IF NOT EXISTS recommendation_feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            rating TEXT NOT NULL,
            view_count_at_time INTEGER,
            created_at TEXT NOT NULL
          );
        `, (err) => {
          if (err) return reject(err);
          database.get(
            `SELECT value FROM app_metadata WHERE key = ?`,
            ['weight_parser_version'],
            (err, row) => {
              if (err) return reject(err);
              if (row && row.value === WEIGHT_PARSER_VERSION) return resolve();

              database.run(`UPDATE products SET weight_grams = NULL`, (err) => {
                if (err) return reject(err);
                database.run(
                  `INSERT INTO app_metadata (key, value) VALUES (?, ?)
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                  ['weight_parser_version', WEIGHT_PARSER_VERSION],
                  (err) => {
                    if (err) reject(err);
                    else resolve();
                  }
                );
              });
            }
          );
        });
      });
    });
  });
}

function upsertProduct(product) {
  return new Promise((resolve, reject) => {
    const database = getDb();
    database.run(`
      INSERT INTO products (product_id, category, name, brand, original_price, discount_price, discount_rate, weight_grams, in_stock, image_url, product_url, scraped_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(product_id) DO UPDATE SET
        name = excluded.name,
        brand = excluded.brand,
        original_price = excluded.original_price,
        discount_price = excluded.discount_price,
        discount_rate = excluded.discount_rate,
        weight_grams = excluded.weight_grams,
        in_stock = excluded.in_stock,
        image_url = excluded.image_url,
        product_url = excluded.product_url,
        scraped_at = excluded.scraped_at
    `, [
      product.product_id,
      product.category,
      product.name,
      product.brand || null,
      product.original_price || null,
      product.discount_price || null,
      product.discount_rate || 0,
      product.weight_grams || null,
      product.in_stock !== undefined ? product.in_stock : 1,
      product.image_url || null,
      product.product_url || null,
      new Date().toISOString()
    ], function (err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

function upsertProducts(products) {
  return new Promise((resolve, reject) => {
    const database = getDb();
    database.serialize(() => {
      database.run('BEGIN TRANSACTION');
      let pending = products.length;
      if (pending === 0) {
        database.run('COMMIT');
        return resolve(0);
      }
      let changed = 0;
      products.forEach(product => {
        database.run(`
          INSERT INTO products (product_id, category, name, brand, original_price, discount_price, discount_rate, weight_grams, in_stock, image_url, product_url, scraped_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(product_id) DO UPDATE SET
            name = excluded.name,
            brand = excluded.brand,
            original_price = excluded.original_price,
            discount_price = excluded.discount_price,
            discount_rate = excluded.discount_rate,
            weight_grams = excluded.weight_grams,
            in_stock = excluded.in_stock,
            image_url = excluded.image_url,
            product_url = excluded.product_url,
            scraped_at = excluded.scraped_at
        `, [
          product.product_id,
          product.category,
          product.name,
          product.brand || null,
          product.original_price || null,
          product.discount_price || null,
          product.discount_rate || 0,
          product.weight_grams || null,
          product.in_stock !== undefined ? product.in_stock : 1,
          product.image_url || null,
          product.product_url || null,
          new Date().toISOString()
        ], function (err) {
          if (err) console.error('Upsert error:', err.message);
          else changed += this.changes;
          pending--;
          if (pending === 0) {
            database.run('COMMIT', (commitErr) => {
              if (commitErr) reject(commitErr);
              else resolve(changed);
            });
          }
        });
      });
    });
  });
}

function getProducts(filters = {}) {
  return new Promise((resolve, reject) => {
    const database = getDb();
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
      weightRange,
      inStockOnly = false,
      sort = 'priceAsc'
    } = filters;

    let where = [];
    let params = [];

    if (category) { where.push('category = ?'); params.push(category); }
    if (minDiscount) { where.push('discount_rate >= ?'); params.push(Number(minDiscount)); }
    if (maxDiscount) { where.push('discount_rate <= ?'); params.push(Number(maxDiscount)); }
    if (minPrice) { where.push('discount_price >= ?'); params.push(Number(minPrice)); }
    if (maxPrice) { where.push('discount_price <= ?'); params.push(Number(maxPrice)); }
    if (keyword) { where.push('(name LIKE ? OR brand LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
    if (brand) { where.push('brand = ?'); params.push(brand); }
    if (weightRange === 'under-1kg') { where.push('weight_grams IS NOT NULL AND weight_grams < 1000'); }
    if (weightRange === '1kg-3kg') { where.push('weight_grams IS NOT NULL AND weight_grams >= 1000 AND weight_grams <= 3000'); }
    if (weightRange === '3kg-5kg') { where.push('weight_grams IS NOT NULL AND weight_grams > 3000 AND weight_grams <= 5000'); }
    if (weightRange === 'over-5kg') { where.push('weight_grams IS NOT NULL AND weight_grams > 5000'); }
    if (inStockOnly === 'true' || inStockOnly === true) { where.push('in_stock = 1'); }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const orderMap = {
      priceAsc: 'discount_price ASC',
      priceDesc: 'discount_price DESC',
      discountDesc: 'discount_rate DESC',
      weightAsc: 'weight_grams IS NULL ASC, weight_grams ASC',
      weightDesc: 'weight_grams IS NULL ASC, weight_grams DESC',
      latest: 'scraped_at DESC',
      nameAsc: 'name ASC'
    };
    const orderClause = 'ORDER BY ' + (orderMap[sort] || 'discount_price ASC');

    const offset = Number(page) * Number(pageSize);
    const limit = Number(pageSize);

    const countSql = `SELECT COUNT(*) as total FROM products ${whereClause}`;
    const dataSql = `SELECT * FROM products ${whereClause} ${orderClause} LIMIT ? OFFSET ?`;

    database.get(countSql, params, (err, countRow) => {
      if (err) return reject(err);
      database.all(dataSql, [...params, limit, offset], (err2, rows) => {
        if (err2) return reject(err2);
        resolve({ products: rows, total: countRow.total, page: Number(page), pageSize: limit });
      });
    });
  });
}

function getBrands(category) {
  return new Promise((resolve, reject) => {
    const database = getDb();
    database.all(
      `SELECT DISTINCT brand FROM products WHERE category = ? AND brand IS NOT NULL ORDER BY brand ASC`,
      [category],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows.map(r => r.brand));
      }
    );
  });
}

function getStats(category) {
  return new Promise((resolve, reject) => {
    const database = getDb();
    database.get(
      `SELECT MIN(discount_price) as minPrice, MAX(discount_price) as maxPrice,
              MIN(original_price) as minOriginalPrice, MAX(original_price) as maxOriginalPrice,
              COUNT(*) as total
       FROM products WHERE category = ?`,
      [category],
      (err, row) => {
        if (err) return reject(err);
        resolve(row);
      }
    );
  });
}

function getScrapeStatus() {
  return new Promise((resolve, reject) => {
    const database = getDb();
    database.all('SELECT * FROM scrape_progress', [], (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function updateScrapeProgress(category, fields) {
  return new Promise((resolve, reject) => {
    const database = getDb();
    const keys = Object.keys(fields);
    const setClause = keys.map(k => `${k} = ?`).join(', ');
    const values = keys.map(k => fields[k]);
    database.run(
      `INSERT INTO scrape_progress (category) VALUES (?)
       ON CONFLICT(category) DO UPDATE SET ${setClause}`,
      [category, ...values],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

function getProductCount(category) {
  return new Promise((resolve, reject) => {
    const database = getDb();
    database.get(
      `SELECT COUNT(*) as count FROM products WHERE category = ?`,
      [category],
      (err, row) => {
        if (err) return reject(err);
        resolve(row ? row.count : 0);
      }
    );
  });
}

async function touchRecUser(userId) {
  const now = new Date().toISOString();
  await run(
    `INSERT INTO rec_users (user_id, created_at, last_seen_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    [userId, now, now]
  );
}

async function recordInterestEvent(event) {
  await touchRecUser(event.user_id);
  await run(`
    INSERT INTO interest_events
      (user_id, event_type, product_id, name, brand, category, weight_grams,
       discount_price, original_price, discount_rate, in_stock, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    event.user_id,
    event.event_type,
    event.product_id,
    event.name || null,
    event.brand || null,
    event.category || null,
    event.weight_grams ?? null,
    event.discount_price ?? null,
    event.original_price ?? null,
    event.discount_rate ?? null,
    event.in_stock !== undefined ? (event.in_stock ? 1 : 0) : null,
    new Date().toISOString()
  ]);
}

async function getInterestEvents(userId) {
  return all(
    `SELECT * FROM interest_events WHERE user_id = ? ORDER BY created_at ASC`,
    [userId]
  );
}

async function getFavouriteIds(userId) {
  const events = await getInterestEvents(userId);
  const favourites = new Set();
  events.forEach(event => {
    if (event.event_type === 'add') favourites.add(event.product_id);
    if (event.event_type === 'remove') favourites.delete(event.product_id);
  });
  return [...favourites];
}

async function getRecommendationCandidates(limit = 400) {
  return all(`
    SELECT * FROM products
    WHERE discount_price IS NOT NULL
    ORDER BY in_stock DESC, discount_rate DESC, scraped_at DESC
    LIMIT ?
  `, [limit]);
}

async function incrementRecommendationView(userId) {
  await touchRecUser(userId);
  await run(`
    INSERT INTO recommendation_views (user_id, view_count) VALUES (?, 1)
    ON CONFLICT(user_id) DO UPDATE SET view_count = view_count + 1
  `, [userId]);
  const rows = await all(
    `SELECT view_count, last_feedback_at FROM recommendation_views WHERE user_id = ?`,
    [userId]
  );
  return rows[0] || { view_count: 1, last_feedback_at: null };
}

async function recordRecommendationFeedback(userId, rating, viewCount) {
  const now = new Date().toISOString();
  await touchRecUser(userId);
  await run(
    `INSERT INTO recommendation_feedback (user_id, rating, view_count_at_time, created_at)
     VALUES (?, ?, ?, ?)`,
    [userId, rating, viewCount || 0, now]
  );
  await run(`
    INSERT INTO recommendation_views (user_id, view_count, last_feedback_at) VALUES (?, 0, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      view_count = 0,
      last_feedback_at = excluded.last_feedback_at
  `, [userId, now]);
}

module.exports = {
  initialize,
  upsertProduct,
  upsertProducts,
  getProducts,
  getBrands,
  getStats,
  getScrapeStatus,
  updateScrapeProgress,
  getProductCount,
  recordInterestEvent,
  getInterestEvents,
  getFavouriteIds,
  getRecommendationCandidates,
  incrementRecommendationView,
  recordRecommendationFeedback
};
