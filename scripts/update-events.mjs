import { chromium } from 'playwright';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const SOURCE = 'https://www.subgamecals.com';
const OUTPUT = new URL('../public/data/events.json', import.meta.url);
const DEBUG_OUTPUT = new URL('../public/data/update-debug.json', import.meta.url);
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

function eventKey(event) {
  return `${event.game}|${event.title}|${event.start.slice(0, 10)}`;
}

function hasExactTime(value) {
  return Boolean(value && !value.endsWith('00:00'));
}

async function loadCalendarPage(page, month) {
  await page.goto(`${SOURCE}/calendar/bar?month=${month}&ver=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForFunction(() => {
    const text = document.body.innerText || '';
    return text.length > 300 && !text.includes('이벤트를 불러오는 중');
  }, null, { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(800);
}

async function collectCalendarCards(page, month) {
  const result = await page.evaluate((games) => {
    const labels = games.flatMap((game) => game.names);
    const results = [...document.querySelectorAll('[data-hc-title][data-hc-sub][data-hc-meta]')]
      .filter((element) => labels.includes(element.dataset.hcSub || ''))
      .map((element) => ({
        title: element.dataset.hcTitle,
        gameName: element.dataset.hcSub,
        meta: element.dataset.hcMeta,
        id: element.dataset.hcMemoKey,
        url: element.href || location.href
      }));
    return { results, bodySample: (document.body.innerText || '').slice(0, 1_500) };
  }, GAME_MAP);

  const [yearText, monthText] = month.split('-');
  const year = Number(yearText);
  const viewMonth = Number(monthText);

  const cards = result.results.map((card) => {
    const game = detectGame(card.gameName);
    const dates = [...card.meta.matchAll(/(\d{1,2})월\s*(\d{1,2})일/g)].map((match) => ({ month: Number(match[1]), day: Number(match[2]) }));
    if (!game || dates.length === 0) return null;
    const start = calendarDate(year, viewMonth, dates[0].month, dates[0].day);
    const last = dates.at(-1);
    const end = dates.length > 1 ? calendarDate(year, viewMonth, last.month, last.day) : null;
    return {
      id: card.id || hash(`${game}|${card.title}|${start}`),
      game,
      title: card.title,
      category: detectCategory(card.meta),
      start,
      end: end === start ? null : end,
      url: card.url
    };
  }).filter(Boolean);
  return { cards, bodySample: result.bodySample };
}

async function readEvent(page, calendarEvent) {
  await page.goto(calendarEvent.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(500);

  let raw = await readResultCard(page, calendarEvent.title);
  if (!raw) {
    const status = page.locator('select[aria-label="상태"]');
    if (await status.count()) {
      await status.selectOption({ label: '전체' });
      await page.waitForTimeout(800);
      raw = await readResultCard(page, calendarEvent.title);
    }
  }

  if (!raw) return null;
  const labelledTimes = [...raw.text.matchAll(/(20\d{2}[-./년]\s*\d{1,2}[-./월]\s*\d{1,2}(?:일)?\s+\d{1,2}:\d{2})[^\n]*(시작|종료)/g)];
  const start = normalizeDate(labelledTimes.find((match) => match[2] === '시작')?.[1]);
  const end = normalizeDate(labelledTimes.find((match) => match[2] === '종료')?.[1]);
  if (!start) return null;

  return {
    ...calendarEvent,
    start,
    end: end && end !== start ? end : calendarEvent.end,
    url: raw.original || calendarEvent.url,
    detailUrl: calendarEvent.url
  };
}

async function readResultCard(page, title) {
  return page.evaluate((targetTitle) => {
    const cards = [...document.querySelectorAll('[role="button"][title="이벤트 상세 보기"]')];
    const card = cards.find((element) => element.innerText.trim().startsWith(targetTitle));
    if (!card) return null;
    const original = [...card.querySelectorAll('a')]
      .find((link) => /원문 열기/.test(link.getAttribute('aria-label') || '') || link.textContent?.trim() === targetTitle)?.href;
    return { text: card.innerText.replace(/\u00a0/g, ' '), original };
  }, title);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const now = new Date();
  const diagnostics = { ranAt: new Date().toISOString(), months: [] };

  try {
    const previousData = JSON.parse(await readFile(OUTPUT, 'utf8').catch(() => '{"events":[]}'));
    const previousByKey = new Map((previousData.events || []).map((event) => [eventKey(event), event]));
    const urls = new Map();
    const calendarEvents = [];
    for (let offset = -1; offset <= 1; offset += 1) {
      const month = monthOffset(now, offset);
      await loadCalendarPage(page, month);
      const cardResult = await collectCalendarCards(page, month);
      calendarEvents.push(...cardResult.cards);
      const targetEvents = cardResult.cards.filter((card) => card.url.includes('/events'));
      targetEvents.forEach((event) => urls.set(eventKey(event), event));
      diagnostics.months.push({ month, detailUrls: targetEvents.length, cards: cardResult.cards.length, bodySample: cardResult.cards.length ? undefined : cardResult.bodySample });
      await page.waitForTimeout(500);
    }

    const events = calendarEvents.map((event) => {
      const previous = previousByKey.get(eventKey(event));
      return previous && hasExactTime(previous.start)
        ? { ...event, start: previous.start, end: previous.end, url: previous.url || event.url, detailUrl: previous.detailUrl }
        : event;
    });
    for (const calendarEvent of urls.values()) {
      try {
        const event = await readEvent(page, calendarEvent);
        if (event) events.push(event);
      } catch (error) {
        console.warn(`일정 상세 수집 실패: ${calendarEvent.url} (${error.message})`);
      }
      await page.waitForTimeout(350);
    }

    const unique = [...new Map(events.map((event) => [eventKey(event), event])).values()]
      .sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title, 'ko'));

    if (unique.length < 3) throw new Error(`수집 결과가 비정상적으로 적습니다: ${unique.length}개`);
    await writeFile(OUTPUT, `${JSON.stringify({ updatedAt: new Date().toISOString(), source: SOURCE, events: unique }, null, 2)}\n`);
    await unlink(DEBUG_OUTPUT).catch(() => {});
    console.log(`일정 ${unique.length}개 갱신 완료`);
  } catch (error) {
    console.error(`갱신 실패, 기존 데이터를 유지합니다: ${error.message}`);
    await writeFile(DEBUG_OUTPUT, `${JSON.stringify({ ...diagnostics, error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

await main();
