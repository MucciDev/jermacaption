import { Browser, Page } from 'puppeteer';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as puppeteer from 'puppeteer';

interface FontCache {
  [key: string]: Promise<string>;
}

interface BrowserPool {
  browser: Browser | null;
  page: Page | null;
  inUse: boolean;
  lastUsed: number;
}

const FONT_CACHE: FontCache = {};
const BROWSER_POOL: BrowserPool = {
  browser: null,
  page: null,
  inUse: false,
  lastUsed: 0
};

const CONFIG = {
  CANVAS_WIDTH: 800,
  FONT_SIZE: 80,
  PADDING: 20,
  BROWSER_TIMEOUT: 30000,
  PAGE_TIMEOUT: 15000,
  BROWSER_IDLE_TIMEOUT: 300000, // 5 minutes
  EMOJI_SIZE: 60,
  EMOJI_MARGIN: 3
};

const FONT_PATHS = {
  impact: './assets/fonts/Impact.ttf',
  arial: './assets/fonts/Arial.ttf',
  emoji: './assets/fonts/Emoji.ttf'
};

const loadFont = async (fontName: string, fontPath: string): Promise<string> => {
  if (!FONT_CACHE[fontName]) {
    FONT_CACHE[fontName] = fs.readFile(fontPath)
      .then(buffer => buffer.toString('base64'))
      .catch(error => {
        delete FONT_CACHE[fontName];
        throw new Error(`Failed to load font ${fontName}: ${error.message}`);
      });
  }
  return FONT_CACHE[fontName];
};

const initializeBrowser = async (): Promise<Browser> => {
  const browser = await puppeteer.launch({
    product: 'chrome',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--no-zygote',
      '--single-process'
    ],
    headless: true,
    timeout: CONFIG.BROWSER_TIMEOUT
  });

  return browser;
};

const getBrowserPage = async (): Promise<Page> => {
  const now = Date.now();
  
  if (BROWSER_POOL.browser && BROWSER_POOL.page && !BROWSER_POOL.inUse) {
    BROWSER_POOL.inUse = true;
    BROWSER_POOL.lastUsed = now;
    return BROWSER_POOL.page;
  }

  if (BROWSER_POOL.browser && BROWSER_POOL.inUse) {
    throw new Error('Browser is currently in use');
  }

  try {
    if (BROWSER_POOL.browser) {
      await BROWSER_POOL.browser.close();
    }
  } catch (error) {
    console.warn('Error closing old browser:', error);
  }

  const browser = await initializeBrowser();
  const page = await browser.newPage();
  
  await page.setDefaultNavigationTimeout(CONFIG.PAGE_TIMEOUT);
  await page.setDefaultTimeout(CONFIG.PAGE_TIMEOUT);

  BROWSER_POOL.browser = browser;
  BROWSER_POOL.page = page;
  BROWSER_POOL.inUse = true;
  BROWSER_POOL.lastUsed = now;

  return page;
};

const releaseBrowserPage = (): void => {
  BROWSER_POOL.inUse = false;
  BROWSER_POOL.lastUsed = Date.now();
};

const processDiscordEmojis = (input: string): string => {
  const emojiRegex = /<(a?):([^:]+):(\d+)>/g;
  return input.replace(emojiRegex, (match, animated, name, id) => {
    const emojiUrl = `https://cdn.discordapp.com/emojis/${id}.png?size=64`;
    return `<img src="${emojiUrl}" alt="${name}" style="height:${CONFIG.EMOJI_SIZE}px;vertical-align:middle;margin:0 ${CONFIG.EMOJI_MARGIN}px;" crossorigin="anonymous" />`;
  });
};

const sanitizeHtml = (input: string): string => {
  const charactersMap: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': '&quot;',
    "'": '&#39;',
    "/": '&#x2F;'
  };
  
  return input.replace(/[&<>"'\/]/g, (char) => charactersMap[char]);
};

const processText = (input: string): string => {
  const processedEmojis = processDiscordEmojis(input);
  const parts = processedEmojis.split(/(<img[^>]*>)/);
  
  return parts.map(part => {
    if (part.startsWith('<img')) {
      return part;
    }
    return sanitizeHtml(part);
  }).join('');
};

const generateHtml = async (text: string, width: number): Promise<string> => {
  const [impactFont, arialFont, emojiFont] = await Promise.all([
    loadFont('impact', FONT_PATHS.impact),
    loadFont('arial', FONT_PATHS.arial),
    loadFont('emoji', FONT_PATHS.emoji)
  ]);

  const processedText = processText(text);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    @font-face {
      font-family: 'Impact';
      src: url('data:font/ttf;base64,${impactFont}');
      font-display: block;
    }
    @font-face {
      font-family: 'Arial';
      src: url('data:font/ttf;base64,${arialFont}');
      font-display: block;
    }
    @font-face {
      font-family: 'Emoji';
      src: url('data:font/ttf;base64,${emojiFont}');
      font-display: block;
    }
    
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    html, body {
      width: ${width}px;
      background-color: white;
      font-family: 'Emoji', 'Impact', 'Arial', sans-serif;
    }
    
    .container {
      margin: ${CONFIG.PADDING / 2}px;
      background-color: white;
      text-align: center;
    }
    
    .text {
      font-size: ${CONFIG.FONT_SIZE}px;
      font-weight: normal;
      color: black;
      line-height: 1.2;
      word-wrap: break-word;
      overflow-wrap: break-word;
      hyphens: auto;
    }
    
    img {
      max-width: 100%;
      height: auto;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="text">${processedText}</div>
  </div>
</body>
</html>`;
};

const ensureDirectoryExists = async (dirPath: string): Promise<void> => {
  try {
    await fs.access(dirPath);
  } catch {
    await fs.mkdir(dirPath, { recursive: true });
  }
};

const generateImage = async (text: string, id: string): Promise<string> => {
  if (!text || text.trim().length === 0) {
    throw new Error('Text cannot be empty');
  }

  if (text.length > 5000) {
    throw new Error('Text is too long');
  }

  const textsDir = './_temp/texts';
  const outputPath = path.join(textsDir, `${id}-text.png`);

  try {
    await ensureDirectoryExists(textsDir);
    
    const html = await generateHtml(text, CONFIG.CANVAS_WIDTH);
    const page = await getBrowserPage();

    await page.setContent(html, { 
      waitUntil: ['networkidle0', 'domcontentloaded'],
      timeout: CONFIG.PAGE_TIMEOUT
    });

    await page.setViewport({ 
      width: CONFIG.CANVAS_WIDTH, 
      height: 100,
      deviceScaleFactor: 1
    });

    const container = await page.$('.container');
    if (!container) {
      throw new Error('Could not find container element');
    }

    const boundingBox = await container.boundingBox();
    if (!boundingBox) {
      throw new Error('Could not get container bounding box');
    }

    const finalHeight = Math.ceil(boundingBox.height) + CONFIG.PADDING;
    
    await page.setViewport({
      width: CONFIG.CANVAS_WIDTH,
      height: finalHeight,
      deviceScaleFactor: 1
    });

    await page.screenshot({
      path: outputPath,
      type: 'png',
      omitBackground: false,
      clip: {
        x: 0,
        y: 0,
        width: CONFIG.CANVAS_WIDTH,
        height: finalHeight
      }
    });

    return outputPath;
  } catch (error) {
    console.error(`Error generating image for ${id}:`, error);
    throw new Error(`Failed to generate image: ${error instanceof Error ? error.message : 'Unknown error'}`);
  } finally {
    releaseBrowserPage();
  }
};

const cleanupBrowser = async (): Promise<void> => {
  if (BROWSER_POOL.browser && !BROWSER_POOL.inUse) {
    try {
      await BROWSER_POOL.browser.close();
    } catch (error) {
      console.warn('Error closing browser during cleanup:', error);
    } finally {
      BROWSER_POOL.browser = null;
      BROWSER_POOL.page = null;
    }
  }
};

setInterval(async () => {
  const now = Date.now();
  if (BROWSER_POOL.browser && 
      !BROWSER_POOL.inUse && 
      now - BROWSER_POOL.lastUsed > CONFIG.BROWSER_IDLE_TIMEOUT) {
    await cleanupBrowser();
  }
}, 60000);

process.on('SIGINT', cleanupBrowser);
process.on('SIGTERM', cleanupBrowser);

export { generateImage };
