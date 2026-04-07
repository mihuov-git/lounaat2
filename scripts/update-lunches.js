const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

const weekdayNames = ['sunnuntai', 'maanantai', 'tiistai', 'keskiviikko', 'torstai', 'perjantai', 'lauantai'];
const weekdayMap = {
  maanantai: ['maanantai', 'ma'],
  tiistai: ['tiistai', 'ti'],
  keskiviikko: ['keskiviikko', 'ke'],
  torstai: ['torstai', 'to'],
  perjantai: ['perjantai', 'pe']
};

const sources = [
  {
    key: 'grillIt',
    name: 'Grill it! Marina',
    subtitle: 'Raflaamo',
    price: '14,90 €',
    url: 'https://www.raflaamo.fi/fi/ravintola/turku/grill-it-marina-turku/menu/lounas',
    parser: parseRaflaamo,
  },
  {
    key: 'viidesNayttamo',
    name: 'Viides Näyttämö',
    subtitle: 'Kulttuuriranta',
    price: '13,70 €',
    url: 'https://www.viidesnayttamo.fi/?page_id=73',
    parser: parseViidesNayttamo,
  },
  {
    key: 'aitiopaikka',
    name: 'Aitiopaikka',
    subtitle: 'Fresco Ravintolat',
    price: '13,50 €',
    url: 'https://www.frescoravintolat.fi/lounas/aitiopaikan-lounaslista/',
    parser: parseAitiopaikka,
  },
];

function getHelsinkiNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Helsinki' }));
}

function getTodayContext() {
  const helsinki = getHelsinkiNow();
  const weekdayName = weekdayNames[helsinki.getDay()];
  const day = helsinki.getDate();
  const month = helsinki.getMonth() + 1;
  const dateLabel = `${day}.${month}.`;
  const dateLabelLong = helsinki.toLocaleDateString('fi-FI', {
    weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric'
  });
  return { helsinki, weekdayName, day, month, dateLabel, dateLabelLong };
}

function normaliseText(text) {
  return text
    .replace(/\u00A0/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function dedupe(items) {
  return [...new Set(items.map((item) => normaliseText(item)).filter(Boolean))];
}

function cleanupText(raw) {
  return normaliseText(
    raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, '\n')
  );
}

function stripCookieBannerLines(text) {
  return text
    .split('\n')
    .map((line) => normaliseText(line))
    .filter(Boolean)
    .filter((line) => !/kumppaneillemme tietoja siitä/i.test(line))
    .filter((line) => !/käytät sivustoamme/i.test(line))
    .filter((line) => !/yhdistää näitä tietoja muihin tietoihin/i.test(line))
    .filter((line) => !/^kiellä$/i.test(line))
    .filter((line) => !/^salli kaikki$/i.test(line))
    .filter((line) => !/^näytä tiedot ja muokkaa$/i.test(line))
    .filter((line) => !/^siirry sisältöön$/i.test(line))
    .filter((line) => !/^fresco ravintolat$/i.test(line))
    .filter((line) => !/^etusivu$/i.test(line))
    .filter((line) => !/^eväste/i.test(line))
    .join('\n');
}

function splitMeaningfulLines(block) {
  return block
    .split(/\n+/)
    .map((line) => normaliseText(line))
    .filter(Boolean)
    .filter((line) => !/^(maanantai|tiistai|keskiviikko|torstai|perjantai)(\s+\d{1,2}\.\d{1,2}\.?)*$/i.test(line))
    .filter((line) => !/^lounaslista/i.test(line))
    .filter((line) => !/^lounasaika/i.test(line))
    .filter((line) => !/^lounas arkisin/i.test(line));
}

function extractTodayBlock(text, ctx) {
  const aliases = weekdayMap[ctx.weekdayName] || [ctx.weekdayName];
  const startPatterns = [
    `${ctx.weekdayName} ${ctx.dateLabel}`,
    `${ctx.weekdayName} ${ctx.day}.${ctx.month}`,
    `${ctx.weekdayName} ${ctx.day}.${ctx.month}.`,
    ...aliases,
  ];

  let startIndex = -1;
  for (const pattern of startPatterns) {
    const idx = text.toLowerCase().indexOf(pattern.toLowerCase());
    if (idx !== -1 && (startIndex === -1 || idx < startIndex)) {
      startIndex = idx;
    }
  }
  if (startIndex === -1) return null;

  const rest = text.slice(startIndex);
  const nextAliases = Object.entries(weekdayMap)
    .filter(([day]) => day !== ctx.weekdayName)
    .flatMap(([, vals]) => vals)
    .sort((a, b) => b.length - a.length);

  let endIndex = rest.length;
  for (const alias of nextAliases) {
    const rx = new RegExp(`\\n\\s*${alias}\\b`, 'i');
    const match = rx.exec(rest.slice(5));
    if (match) {
      endIndex = Math.min(endIndex, match.index + 5);
    }
  }

  return rest.slice(0, endIndex).trim();
}

function parseRaflaamo(text, ctx) {
  const block = extractTodayBlock(text, ctx);
  if (!block) return [];

  const lines = splitMeaningfulLines(block)
    .filter((line) => !/^lounas[: ]/i.test(line))
    .filter((line) => !/^lounasmenu$/i.test(line))
    .filter((line) => !/^lounasmenu\b/i.test(line))
    .filter((line) => !/^\d{1,2},\d{2}\s*€/.test(line))
    .filter((line) => !/^lisäkkeenä tarjoilemme/i.test(line))
    .filter((line) => !/^(g|l|vl|ve|m|gp|vep)(\s+(g|l|vl|ve|m|gp|vep))*$/i.test(line))
    .filter((line) => !/^\*+$/.test(line));

  const cleaned = [];
  for (const line of lines) {
    if (/^jälkiruokana:/i.test(line) || /^perinteiset/i.test(line) || /^paistettua/i.test(line) || /^kasvis-/i.test(line)) {
      cleaned.push(line);
      continue;
    }
    if (/^lounasmenu/i.test(line)) continue;
    if (/^(katkarapuskagen|päivän kala-annos|vanilja)/i.test(line)) {
      cleaned.push(line);
    }
  }

  return dedupe(cleaned).slice(0, 10);
}

function parseViidesNayttamo(text, ctx) {
  const lower = text.toLowerCase();

  const dateAnchors = [
    `${ctx.weekdayName} ${ctx.day}.${ctx.month}.`.toLowerCase(),
    `${ctx.weekdayName} ${ctx.day}.${ctx.month}`.toLowerCase()
  ];

  let startIndex = -1;
  for (const anchor of dateAnchors) {
    const idx = lower.indexOf(anchor);
    if (idx !== -1) {
      startIndex = idx;
      break;
    }
  }

  if (startIndex === -1) return [];

  const fromToday = text.slice(startIndex);

  const nextDayMarkers = ['maanantai', 'tiistai', 'keskiviikko', 'torstai', 'perjantai']
    .filter((d) => d !== ctx.weekdayName);

  let endIndex = fromToday.length;
  for (const marker of nextDayMarkers) {
    const rx = new RegExp(`\\n\\s*${marker}\\s+\\d{1,2}\\.\\d{1,2}\\.?`, 'i');
    const match = rx.exec(fromToday.slice(5));
    if (match) {
      endIndex = Math.min(endIndex, match.index + 5);
    }
  }

  const dayBlock = fromToday.slice(0, endIndex).trim();

  return dedupe(
    dayBlock
      .split(/\n+/)
      .map((line) => normaliseText(line))
      .filter(Boolean)
      .filter((line) => !/^(maanantai|tiistai|keskiviikko|torstai|perjantai)\s+\d{1,2}\.\d{1,2}\.?$/i.test(line))
      .filter((line) => !/^sisältää /i.test(line))
      .filter((line) => !/^buffetlounas/i.test(line))
      .filter((line) => !/^salaattilounas/i.test(line))
      .filter((line) => !/^viikon lautasannos/i.test(line))
      .filter((line) => !/^kermainen lohikeitto/i.test(line))
      .filter((line) => !/^päivän kala/i.test(line))
      .filter((line) => !/^sis\./i.test(line))
  ).slice(0, 4);
}

function isLikelyAitiopaikkaFoodLine(line) {
  const lower = line.toLowerCase();

  if (lower.includes('aitiopaikan lounaslista')) return false;
  if (lower.includes('tutustu ravintola')) return false;
  if (lower.includes('ravintola aitiopaikka')) return false;
  if (lower.includes('lämminruokalounas')) return false;
  if (lower.includes('keitto+salaattilounas')) return false;
  if (lower.includes('lounashinnat')) return false;
  if (lower.includes('fresco ravintolat')) return false;
  if (lower.includes('etusivu')) return false;
  if (/, rauma$/.test(lower) || /, turku$/.test(lower) || /, laitila$/.test(lower)) return false;
  if (/^kiellä$/i.test(line) || /^salli kaikki$/i.test(line) || /^näytä tiedot ja muokkaa$/i.test(line) || /^siirry sisältöön$/i.test(line)) return false;
  if (/kumppaneillemme tietoja siitä/i.test(line)) return false;
  if (/käytät sivustoamme/i.test(line)) return false;
  if (/yhdistää näitä tietoja muihin tietoihin/i.test(line)) return false;
  if (/^l\s*=|^m\s*=|^g\s*=|^v\s*=/i.test(line)) return false;
  if (/^lihojen ja broilerin alkuperämaa/i.test(line)) return false;

  return /,/.test(line) || /\b[LMGV](?:,[LMGV])+$/i.test(line) || /\b[LMGV]$/i.test(line);
}

function parseAitiopaikka(text, ctx) {
  const lower = text.toLowerCase();
  const sectionStart = lower.indexOf('aitiopaikan lounaslista');
  if (sectionStart === -1) return [];

  const afterStart = text.slice(sectionStart);

  const dayAnchors = [
    `${ctx.weekdayName} ${ctx.dateLabel}`.toLowerCase(),
    `${ctx.weekdayName} ${ctx.day}.${ctx.month}`.toLowerCase(),
    `${ctx.weekdayName} ${ctx.day}.${ctx.month}.`.toLowerCase(),
    ctx.weekdayName.toLowerCase()
  ];

  let dayStart = -1;
  const afterStartLower = afterStart.toLowerCase();
  for (const anchor of dayAnchors) {
    const idx = afterStartLower.indexOf(anchor);
    if (idx !== -1) {
      dayStart = idx;
      break;
    }
  }

  if (dayStart === -1) return [];

  const fromDay = afterStart.slice(dayStart);

  const nextDayMarkers = ['maanantai', 'tiistai', 'keskiviikko', 'torstai', 'perjantai']
    .filter((d) => d !== ctx.weekdayName);

  let endIndex = fromDay.length;
  for (const marker of nextDayMarkers) {
    const rx = new RegExp(`\\n\\s*${marker}\\b`, 'i');
    const match = rx.exec(fromDay.slice(5));
    if (match) {
      endIndex = Math.min(endIndex, match.index + 5);
    }
  }

  const dayBlock = fromDay.slice(0, endIndex).trim();

  const lines = dayBlock
    .split(/\n+/)
    .map((line) => normaliseText(line))
    .filter(Boolean)
    .filter((line) => !/^(maanantai|tiistai|keskiviikko|torstai|perjantai)(\s+\d{1,2}\.\d{1,2}\.?)*$/i.test(line))
    .filter(isLikelyAitiopaikkaFoodLine);

  return dedupe(lines).slice(0, 5);
}

async function fetchSource(page, source, ctx) {
  await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  const cookieSelectors = [
    'button:has-text("Salli kaikki")',
    'button:has-text("Hyväksy")',
    'button:has-text("Accept all")',
    'button:has-text("Accept")'
  ];

  for (const selector of cookieSelectors) {
    try {
      const btn = page.locator(selector).first();
      if (await btn.isVisible({ timeout: 1000 })) {
        await btn.click({ timeout: 1000 });
        await page.waitForTimeout(1500);
        break;
      }
    } catch (e) {
        // jatketaan
    }
  }

  const bodyText = stripCookieBannerLines(
    normaliseText(await page.locator('body').innerText())
  );
  const html = stripCookieBannerLines(
    cleanupText(await page.content())
  );

  const combined = `${bodyText}\n${html}`;
  const items = source.parser(combined, ctx);
  return items;
}

async function main() {
  const ctx = getTodayContext();
  const outPath = path.join(__dirname, '..', 'lunch-data.json');

  if (!['maanantai', 'tiistai', 'keskiviikko', 'torstai', 'perjantai'].includes(ctx.weekdayName)) {
    const weekendPayload = {
      generatedAt: new Date().toISOString(),
      dateLabel: ctx.dateLabelLong,
      weekdayName: ctx.weekdayName,
      mode: 'weekend',
      results: sources.map((source) => ({
        key: source.key,
        name: source.name,
        subtitle: source.subtitle,
        price: source.price,
        url: source.url,
        items: [],
        status: 'closed',
        message: 'Ei lounastarjoilua viikonloppuna.'
      }))
    };
    await fs.writeFile(outPath, JSON.stringify(weekendPayload, null, 2), 'utf8');
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: 'fi-FI', timezoneId: 'Europe/Helsinki' });
  const results = [];

  try {
    for (const source of sources) {
      try {
        const items = await fetchSource(page, source, ctx);
        results.push({
          key: source.key,
          name: source.name,
          subtitle: source.subtitle,
          price: source.price,
          url: source.url,
          items,
          status: items.length ? 'ok' : 'missing',
          message: items.length ? '' : 'Tämän päivän rivejä ei löytynyt lähdesivulta.'
        });
      } catch (error) {
        results.push({
          key: source.key,
          name: source.name,
          subtitle: source.subtitle,
          price: source.price,
          url: source.url,
          items: [],
          status: 'error',
          message: `Haku epäonnistui: ${error.message}`
        });
      }
    }
  } finally {
    await browser.close();
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    dateLabel: ctx.dateLabelLong,
    weekdayName: ctx.weekdayName,
    mode: 'automatic',
    results,
  };

  await fs.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
