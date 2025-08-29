const playwright = require('playwright');
const fs = require('fs');

async function testScrape() {
  // 啟動瀏覽器 (headless: false 以查看過程；若超時問題持續，可改為 true)
  const browser = await playwright.chromium.launch({ headless: false });
  const page = await browser.newPage();
  
  // 設置用戶代理以模擬真實瀏覽器
  await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' });
  
  const allProducts = [];
  let pageNo = 0;
  let hasMore = true;
  
  try {
    while (hasMore) {
      // 構建當前頁URL (pageNo從0開始)
      const url = `https://www.hktvmall.com/hktv/zh/search_a/?keyword=%E8%B2%93%E7%B3%A7&bannerCategory=AA22000000000&pageNo=${pageNo}`;
      console.log(`[測試] 導航到第 ${pageNo + 1} 頁: ${url}`);
      
      // 加載頁面並等待內容 (改為 'domcontentloaded' 條件，並增加超時到180000ms)
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
      console.log(`[測試] 第 ${pageNo + 1} 頁基本加載成功`);
      
      // 額外等待動態內容並多次滾動頁面以觸發載入
      await page.waitForTimeout(15000); // 等待15秒
      await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight)); // 滾動到底部
      await page.waitForTimeout(5000);
      await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight)); // 再次滾動
      await page.waitForTimeout(5000);
      console.log(`[測試] 已等待第 ${pageNo + 1} 頁動態內容載入並滾動頁面`);
      
      // 等待產品列表區域出現 (基於您提供的JS Path和XPath)
      await page.waitForSelector('#search-result-wrapper > div > div.wrapper-content-right', { timeout: 180000 });
      console.log(`[測試] 檢測到第 ${pageNo + 1} 頁產品列表區域`);
      
      // 等待產品卡片出現 (基於您提供的JS Path和XPath)
      await page.waitForSelector('#algolia-search-result-container > div > div > span', { timeout: 180000 });
      console.log(`[測試] 檢測到第 ${pageNo + 1} 頁產品卡片`);
      
      // 提取數據，使用您提供的結構定位所有產品卡片
      const currentPageProducts = await page.evaluate(() => {
        const productList = document.querySelector('#search-result-wrapper > div > div.wrapper-content-right');
        if (!productList) return [];
        
        const productNodes = productList.querySelectorAll('#algolia-search-result-container > div > div > span');
        const filteredProducts = [];
        
        productNodes.forEach(n => {
          const name = n.querySelector('.brand-product-name')?.innerText.trim() || '未知名稱';
          const originalPriceText = n.querySelector('.promotional span')?.innerText.trim() || 'N/A';
          const discountPriceText = n.querySelector('.price .discount')?.innerText.trim() || originalPriceText;
          const link = n.querySelector('a')?.href || '無連結';
          const imageUrl = n.querySelector('img')?.src || '無圖片';
          
          // 過濾無效項目
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
        console.log(`[測試] 第 ${pageNo + 1} 頁未提取到產品 - 停止抓取`);
        hasMore = false;
      } else {
        allProducts.push(...currentPageProducts);
        console.log(`[測試] 成功從第 ${pageNo + 1} 頁提取 ${currentPageProducts.length} 個產品`);
        pageNo++;
      }
      
      // 拍攝當前頁截圖
      await page.screenshot({ path: `page-${pageNo}-screenshot.png`, fullPage: true });
      console.log(`[測試] 第 ${pageNo} 頁截圖保存為 page-${pageNo}-screenshot.png`);
    }
    
    // 輸出所有頁的產品
    if (allProducts.length === 0) {
      console.log('[測試] 未提取到任何產品。');
    } else {
      console.log(`[測試] 成功從所有頁提取 ${allProducts.length} 個產品:`);
      allProducts.forEach((product, index) => {
        console.log(`產品 ${index + 1}:`);
        console.log(`  名稱: ${product.name}`);
        console.log(`  原價: ${product.originalPrice}`);
        console.log(`  折扣價: ${product.discountPrice}`);
        console.log(`  折扣率: ${product.discountRate}`);
        console.log(`  圖片URL: ${product.imageUrl}`);
        console.log(`  連結: ${product.link}`);
        console.log('---');
      });
    }
  } catch (error) {
    console.error('[測試錯誤] 測試抓取失敗:', error.message);
    console.log('[提示] 分享輸出以繼續調試。');
  } finally {
    await browser.close();
  }
}

// 運行測試 (貓糧)
testScrape();