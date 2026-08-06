import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
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

function calendarDate(year, viewMonth, month, day) {
  let resolvedYear = year;
  if (month - viewMonth > 6) resolvedYear -= 1;
  if (viewMonth - month > 6) resolvedYear += 1;
  return `${resolvedYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} 00:00`;
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

async function collectCalendarCards(page, month) {
  await page.goto(`${SOURCE}/calendar?month=${month}&ver=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(1_200);

  const cards = await page.evaluate((games) => {
    const labels = games.flatMap((game) => game.names);
    const results = [];
    const gameNodes = [...document.querySelectorAll('body *')].filter((element) => {
      const text = (element.textContent || '').trim();
      return labels.includes(text) && element.children.length === 0;
    });

    for (const gameNode of gameNodes) {
      let node = gameNode.parentElement;
      let candidate = null;
      for (let depth = 0; node && node !== document.body && depth < 9; depth += 1, node = node.parentElement) {
        const text = (node.innerText || '').trim();
        if (text.length > 15 && text.length < 1_000 && /\d{1,2}월\s*\d{1,2}일/.test(text) && /(픽업|업데이트|공식방송|공식 방송|이벤트|출시)/.test(text)) {
          candidate = node;
          break;
        }
      }
      if (!candidate) continue;
      const link = [...candidate.querySelectorAll('a[href]')].find((anchor) => anchor.href.includes('/events/'));
      results.push({
        gameName: (gameNode.textContent || '').trim(),
        lines: (candidate.innerText || '').split('\n').map((line) => line.trim()).filter(Boolean),
        url: link?.href || location.href
      });
    }
    return results;
  }, GAME_MAP);

  const [yearText, monthText] = month.split('-');
  const year = Number(yearText);
  const viewMonth = Number(monthText);

  return cards.map((card) => {
    const game = detectGame(card.gameName);
    const fullText = card.lines.join(' ');
    const dates = [...fullText.matchAll(/(\d{1,2})월\s*(\d{1,2})일/g)].map((match) => ({ month: Number(match[1]), day: Number(match[2]) }));
    if (!game || dates.length === 0) return null;
    const metadata = /^(\d+|[월화수목금토일]|예정|진행중|종료|시작|일정 자세히 보기|일정 접기|총 \d+개|픽업|업데이트|공식방송|공식 방송|이벤트|오프라인 이벤트|출시)$/;
    const title = card.lines
      .filter((line) => !GAME_MAP.some((item) => item.names.includes(line)))
      .filter((line) => !metadata.test(line))
      .filter((line) => !/\d{1,2}월\s*\d{1,2}일/.test(line))
      .filter((line) => !/^(예정|진행중|종료)\s*\d*$/.test(line))
      .sort((a, b) => b.length - a.length)[0];
    if (!title) return null;
    const start = calendarDate(year, viewMonth, dates[0].month, dates[0].day);
    const last = dates.at(-1);
    const end = dates.length > 1 ? calendarDate(year, viewMonth, last.month, last.day) : null;
    return {
      id: hash(`${game}|${title}|${start}`),
      game,
      title,
      category: detectCategory(fullText),
      start,
      end: end === start ? null : end,
      url: card.url
    };
  }).filter(Boolean);
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
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const now = new Date();

  try {
    const urls = new Set();
    const calendarEvents = [];
    for (let offset = -2; offset <= 6; offset += 1) {
      const month = monthOffset(now, offset);
      const found = await collectEventUrls(page, month);
      found.forEach((url) => urls.add(url));
      if (found.length === 0) calendarEvents.push(...await collectCalendarCards(page, month));
      await page.waitForTimeout(500);
    }

    const events = [...calendarEvents];
    for (const url of urls) {
      try {
        const event = await readEvent(page, url);
        if (event) events.push(event);
      } catch (error) {
        console.warn(`일정 상세 수집 실패: ${url} (${error.message})`);
      }
      await page.waitForTimeout(350);
    }

    const unique = [...new Map(events.map((event) => [`${event.game}|${event.title}|${event.start.slice(0, 10)}`, event])).values()]
      .sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title, 'ko'));

    if (unique.length < 3) throw new Error(`수집 결과가 비정상적으로 적습니다: ${unique.length}개`);
    await writeFile(OUTPUT, `${JSON.stringify({ updatedAt: new Date().toISOString(), source: SOURCE, events: unique }, null, 2)}\n`);
    console.log(`일정 ${unique.length}개 갱신 완료`);
  } catch (error) {
    console.error(`갱신 실패, 기존 데이터를 유지합니다: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

await main();
