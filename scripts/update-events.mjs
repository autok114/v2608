import { unlink, writeFile } from 'node:fs/promises';

const SOURCE = 'https://www.subgamecals.com';
const API = 'https://lsvptosgnbwgsteuwstf.supabase.co/rest/v1/events';
// This is the source site's browser-exposed anonymous read key, not a private credential.
const API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxzdnB0b3NnbmJ3Z3N0ZXV3c3RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTcyNzQyNzMsImV4cCI6MjA3Mjg1MDI3M30.mz2GaTEuRlre_0nGlG-YyodarResnZn3MZ8cF42lBx8';
const OUTPUT = new URL('../public/data/events.json', import.meta.url);
const DEBUG_OUTPUT = new URL('../public/data/update-debug.json', import.meta.url);

const GAME_IDS = {
  '489685c5-04d1-48a6-8c21-e209d862a6fa': 'wuwa',
  '1a8a6b1c-dd10-44a8-849a-87a9a0531645': 'hsr',
  '02e95306-43e6-49b3-a389-024fc97653e2': 'zzz'
};

const TYPE_MAP = {
  update: 'update',
  official_broadcast: 'broadcast',
  event: 'event',
  offline_event: 'offline',
  pickup: 'banner',
  release: 'release'
};

function sourceDate(value) {
  if (!value) return null;
  const matched = value.match(/^(20\d{2})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!matched) return null;
  return `${matched[1]}-${matched[2]}-${matched[3]} ${matched[4]}:${matched[5]}`;
}

function monthRange() {
  const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1_000);
  const year = kstNow.getUTCFullYear();
  const month = kstNow.getUTCMonth();
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month + 2, 1));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10)
  };
}

function detailUrl(title) {
  return `${SOURCE}/events?q=${encodeURIComponent(title)}`;
}

async function collectEvents() {
  const range = monthRange();
  const query = new URLSearchParams({
    select: 'id,game_id,title,type,start_at,end_at,status,source_url',
    game_id: `in.(${Object.keys(GAME_IDS).join(',')})`,
    start_at: `lt.${range.end}`,
    or: `(end_at.is.null,end_at.gte.${range.start})`,
    order: 'start_at.asc,title.asc'
  });
  const response = await fetch(`${API}?${query}`, {
    headers: { apikey: API_KEY, Authorization: `Bearer ${API_KEY}` }
  });
  if (!response.ok) throw new Error(`공개 일정 API 응답 오류: HTTP ${response.status}`);

  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('공개 일정 API 응답 형식이 올바르지 않습니다.');

  const events = rows.map((row) => {
    const game = GAME_IDS[row.game_id];
    const start = sourceDate(row.start_at);
    if (!game || !row.id || !row.title || !start) return null;
    const details = detailUrl(row.title);
    return {
      id: row.id,
      game,
      title: row.title,
      category: TYPE_MAP[row.type] || 'other',
      start,
      end: sourceDate(row.end_at),
      url: row.source_url || details,
      detailUrl: details
    };
  }).filter(Boolean);

  return { events, range, received: rows.length };
}

async function main() {
  const diagnostics = { ranAt: new Date().toISOString() };
  try {
    const { events, range, received } = await collectEvents();
    if (events.length < 3) throw new Error(`수집 결과가 비정상적으로 적습니다: ${events.length}개`);
    await writeFile(OUTPUT, `${JSON.stringify({ updatedAt: new Date().toISOString(), source: SOURCE, events }, null, 2)}\n`);
    await unlink(DEBUG_OUTPUT).catch(() => {});
    console.log(`일정 ${events.length}개 갱신 완료 (${range.start}~${range.end}, 원본 ${received}개)`);
  } catch (error) {
    console.error(`갱신 실패, 기존 데이터를 유지합니다: ${error.message}`);
    await writeFile(DEBUG_OUTPUT, `${JSON.stringify({ ...diagnostics, error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

await main();
