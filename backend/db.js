const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, 'products.db');

let db;

function getDb() {
  if (!db) {
    db = new sqlite3.Database(DB_PATH);
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA synchronous = NORMAL');
  }
  return db;
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
          in_stock INTEGER DEFAULT 1,
          image_url TEXT,
          product_url TEXT,
          scraped_at TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      database.run(`CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)`);
      database.run(`CREATE INDEX IF NOT EXISTS idx_products_discount_rate ON products(discount_rate)`);
      database.run(`CREATE INDEX IF NOT EXISTS idx_products_discount_price ON products(discount_price)`);
      database.run(`CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand)`);
      database.run(`CREATE INDEX IF NOT EXISTS idx_products_in_stock ON products(in_stock)`);

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
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

function upsertProduct(product) {
  return new Promise((resolve, reject) => {
    const database = getDb();
    database.run(`
      INSERT INTO products (product_id, category, name, brand, original_price, discount_price, discount_rate, in_stock, image_url, product_url, scraped_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(product_id) DO UPDATE SET
        name = excluded.name,
        brand = excluded.brand,
        original_price = excluded.original_price,
        discount_price = excluded.discount_price,
        discount_rate = excluded.discount_rate,
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
          INSERT INTO products (product_id, category, name, brand, original_price, discount_price, discount_rate, in_stock, image_url, product_url, scraped_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(product_id) DO UPDATE SET
            name = excluded.name,
            brand = excluded.brand,
            original_price = excluded.original_price,
            discount_price = excluded.discount_price,
            discount_rate = excluded.discount_rate,
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
    if (inStockOnly === 'true' || inStockOnly === true) { where.push('in_stock = 1'); }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const orderMap = {
      priceAsc: 'discount_price ASC',
      priceDesc: 'discount_price DESC',
      discountDesc: 'discount_rate DESC',
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

module.exports = {
  initialize,
  upsertProduct,
  upsertProducts,
  getProducts,
  getBrands,
  getStats,
  getScrapeStatus,
  updateScrapeProgress,
  getProductCount
};
