import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const SOURCE = 'https://www.subgamecals.com';
const OUTPUT = new URL('../public/data/events.json', import.meta.url);
const GAME_MAP = [
  { id: 'wuwa', names: ['명조: 워더링 웨이브', '명조:워더링 웨이브'] },
  { id: 'hsr', names: ['붕괴: 스타레일'] },
  { id: 'zzz', names: ['젠레스 존 제로'] }
];

function hash(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 16);
}

function monthOffset(base, offset) {
  const date = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function detectGame(text) {
  return GAME_MAP.find((game) => game.names.some((name) => text.includes(name)))?.id ?? null;
}

function detectCategory(text) {
  if (/오프라인|팝업|콜라보 카페|페스티벌|월드 투어/.test(text)) return 'offline';
  if (/공식\s*방송|프리뷰|특별\s*방송|스페셜 프로그램/.test(text)) return 'broadcast';
  if (/픽업|워프|변조|튜닝|기원/.test(text)) return 'banner';
  if (/업데이트|버전/.test(text)) return 'update';
  if (/출시|오픈/.test(text)) return 'release';
  if (/이벤트/.test(text)) return 'event';
  return 'other';
}

function normalizeDate(value) {
  if (!value) return null;
  const matched = value.match(/(20\d{2})[-./년]\s*(\d{1,2})[-./월]\s*(\d{1,2})(?:일)?(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!matched) return null;
  const [, year, month, day, hour = '00', minute = '00'] = matched;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ${hour.padStart(2, '0')}:${minute}`;
}

async function collectEventUrls(page, month) {
  await page.goto(`${SOURCE}/calendar?month=${month}&ver=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(1_200);

  return page.evaluate((gameNames) => {
    const names = gameNames.flat();
    const results = new Set();
    document.querySelectorAll('a[href*="/events/"]').forEach((anchor) => {
      let node = anchor;
      for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
        const text = node.textContent || '';
        if (names.some((name) => text.includes(name))) {
          results.add(new URL(anchor.getAttribute('href'), location.origin).href);
          break;
        }
      }
    });
    return [...results];
  }, GAME_MAP.map((game) => game.names));
}

async function readEvent(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(300);
  const raw = await page.evaluate(() => {
    const bodyText = document.body.innerText.replace(/\u00a0/g, ' ');
    const heading = document.querySelector('h1')?.textContent?.trim() || document.title.split(' - ')[0].trim();
    const original = [...document.querySelectorAll('a')].find((link) => /원문/.test(link.textContent || ''))?.href || location.href;
    const times = [...bodyText.matchAll(/20\d{2}[-./년]\s*\d{1,2}[-./월]\s*\d{1,2}(?:일)?(?:\s+\d{1,2}:\d{2})?/g)].map((match) => match[0]);
    return { bodyText, heading, original, times, detailUrl: location.href };
  });

  const game = detectGame(raw.bodyText);
  if (!game || !raw.heading) return null;
  const startIndex = raw.bodyText.indexOf('시작');
  const endIndex = raw.bodyText.indexOf('종료', startIndex + 1);
  const startSection = startIndex >= 0 ? raw.bodyText.slice(startIndex, endIndex > startIndex ? endIndex : startIndex + 100) : '';
  const endSection = endIndex >= 0 ? raw.bodyText.slice(endIndex, endIndex + 100) : '';
  const start = normalizeDate(startSection) || normalizeDate(raw.times.at(-2)) || normalizeDate(raw.times[0]);
  const end = normalizeDate(endSection) || (raw.times.length > 1 ? normalizeDate(raw.times.at(-1)) : null);
  if (!start) return null;

  return {
    id: url.match(/\/events\/(?:e-)?([^/?#]+)/)?.[1] || hash(`${game}|${raw.heading}|${start}`),
    game,
    title: raw.heading,
    category: detectCategory(`${raw.heading}\n${raw.bodyText}`),
    start,
    end: end === start ? null : end,
    url: raw.original || raw.detailUrl,
    detailUrl: raw.detailUrl
  };
}

async function main() {
  const previous = JSON.parse(await readFile(OUTPUT, 'utf8'));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const now = new Date();

  try {
    const urls = new Set();
    for (let offset = -2; offset <= 6; offset += 1) {
      const month = monthOffset(now, offset);
      const found = await collectEventUrls(page, month);
      found.forEach((url) => urls.add(url));
      await page.waitForTimeout(500);
    }

    const events = [];
    for (const url of urls) {
      try {
        const event = await readEvent(page, url);
        if (event) events.push(event);
      } catch (error) {
        console.warn(`일정 상세 수집 실패: ${url} (${error.message})`);
      }
      await page.waitForTimeout(350);
    }

    const unique = [...new Map(events.map((event) => [event.id, event])).values()]
      .sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title, 'ko'));

    if (unique.length < 3) throw new Error(`수집 결과가 비정상적으로 적습니다: ${unique.length}개`);
    await writeFile(OUTPUT, `${JSON.stringify({ updatedAt: new Date().toISOString(), source: SOURCE, events: unique }, null, 2)}\n`);
    console.log(`일정 ${unique.length}개 갱신 완료`);
  } catch (error) {
    console.error(`갱신 실패, 기존 데이터를 유지합니다: ${error.message}`);
    await writeFile(OUTPUT, `${JSON.stringify(previous, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

await main();
