const express = require('express');
const playwright = require('playwright');
const fs = require('fs');
const app = express();
const port = 3000; // 您的 baseUrl 是 localhost:3000

let cachedProducts = []; // 緩存抓取的產品數據

// 抓取函數 (從 scraper.js 複製並調整)
async function scrapeAllPages() {
  if (cachedProducts.length > 0) return cachedProducts; // 如果已緩存，直接返回
  
  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' });
  
  const allProducts = [];
  let pageNo = 0;
  let hasMore = true;
  
  while (hasMore) {
    const url = `https://www.hktvmall.com/hktv/zh/search_a/?keyword=%E8%B2%93%E7%B3%A7&bannerCategory=AA22000000000&pageNo=${pageNo}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
    
    await page.waitForTimeout(15000);
    await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
    await page.waitForTimeout(5000);
    await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
    await page.waitForTimeout(5000);
    
    await page.waitForSelector('#search-result-wrapper > div > div.wrapper-content-right', { timeout: 180000 });
    await page.waitForSelector('#algolia-search-result-container > div > div > span', { timeout: 180000 });
    
    const currentPageProducts = await page.evaluate(() => {
      const productNodes = document.querySelectorAll('#algolia-search-result-container > div > div > span');
      const filteredProducts = [];
      productNodes.forEach(n => {
        const name = n.querySelector('.brand-product-name')?.innerText.trim() || '未知名稱';
        const originalPriceText = n.querySelector('.promotional span')?.innerText.trim() || 'N/A';
        const discountPriceText = n.querySelector('.price .discount')?.innerText.trim() || originalPriceText;
        const link = n.querySelector('a')?.href || '無連結';
        const imageUrl = n.querySelector('img')?.src || '無圖片';
        
        if (name !== '未知名稱' && originalPriceText !== 'N/A') {
          const originalPrice = parseFloat(originalPriceText.replace(/[^0-9.]/g, '')) || 0;
          const discountPrice = parseFloat(discountPriceText.replace(/[^0-9.]/g, '')) || originalPrice;
          const discountRate = (originalPrice > 0 && discountPrice < originalPrice) ? Math.round((1 - discountPrice / originalPrice) * 100) : 0;
          
          filteredProducts.push({
            name,
            originalPrice: originalPriceText,
            discountPrice: discountPriceText,
            discountRate: `${discountRate}%`,
            imageUrl,
            link
          });
        }
      });
      return filteredProducts;
    });
    
    if (currentPageProducts.length === 0) {
      hasMore = false;
    } else {
      allProducts.push(...currentPageProducts);
      pageNo++;
    }
  }
  
  await browser.close();
  cachedProducts = allProducts; // 緩存數據
  return allProducts;
}

// API 端點：獲取產品 (支持分頁、過濾、排序)
app.get('/api/products', async (req, res) => {
  try {
    const products = await scrapeAllPages(); // 抓取或從緩存獲取
    
    // 應用過濾
    let filtered = products;
    const minDiscount = parseInt(req.query.minDiscount) || 0;
    const minPrice = parseFloat(req.query.minPrice) || null;
    const maxPrice = parseFloat(req.query.maxPrice) || null;
    const keyword = req.query.keyword?.toLowerCase() || '';
    
    filtered = filtered.filter(p => {
      const rate = parseInt(p.discountRate) || 0;
      const price = parseFloat(p.discountPrice.replace(/[^0-9.]/g, '')) || 0;
      return rate >= minDiscount &&
             (minPrice === null || price >= minPrice) &&
             (maxPrice === null || price <= maxPrice) &&
             p.name.toLowerCase().includes(keyword);
    });
    
    // 應用排序
    const sort = req.query.sort || 'priceAsc';
    if (sort === 'priceAsc') filtered.sort((a, b) => parseFloat(a.discountPrice.replace(/[^0-9.]/g, '')) - parseFloat(b.discountPrice.replace(/[^0-9.]/g, '')));
    if (sort === 'discountDesc') filtered.sort((a, b) => parseInt(b.discountRate) - parseInt(a.discountRate));
    // 'latest' 可根據需要添加 (e.g., 假設有日期欄位)
    
    // 應用分頁
    const page = parseInt(req.query.page) || 0;
    const pageSize = parseInt(req.query.pageSize) || 20;
    const paginated = filtered.slice(page * pageSize, (page + 1) * pageSize);
    
    res.json(paginated);
  } catch (error) {
    res.status(500).json({ error: '抓取失敗' });
  }
});

// 啟動伺服器
app.listen(port, () => {
  console.log(`伺服器運行在 http://localhost:${port}`);
});