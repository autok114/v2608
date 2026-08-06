const GAME_LABELS = { wuwa: '명조', hsr: '붕스', zzz: '젠존제' };
const CATEGORY_LABELS = {
  update: '업데이트', broadcast: '공식 방송', event: '이벤트', offline: '오프라인 이벤트', banner: '픽업', release: '출시', other: '기타'
};

const state = {
  cursor: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  events: [],
  enabledGames: new Set(['wuwa', 'hsr', 'zzz'])
};

const grid = document.querySelector('#calendarGrid');
const monthLabel = document.querySelector('#monthLabel');
const updatedAt = document.querySelector('#updatedAt');
const dialog = document.querySelector('#eventDialog');
const dialogContent = document.querySelector('#dialogContent');

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseKst(value) {
  if (!value) return null;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  return new Date(`${normalized}${/[zZ]|[+-]\d\d:\d\d$/.test(normalized) ? '' : '+09:00'}`);
}

function formatDateTime(value) {
  const date = parseKst(value);
  if (!date) return '미정';
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}

function visibleEventsFor(date) {
  const key = dateKey(date);
  return state.events.filter((event) => {
    if (!state.enabledGames.has(event.game)) return false;
    const start = event.start.slice(0, 10);
    const end = (event.end || event.start).slice(0, 10);
    return key >= start && key <= end;
  });
}

function openEvent(event) {
  dialogContent.innerHTML = `
    <span class="dialog-game ${event.game}">${GAME_LABELS[event.game]}</span>
    <h2>${escapeHtml(event.title)}</h2>
    <dl>
      <dt>유형</dt><dd>${CATEGORY_LABELS[event.category] || '일정'}</dd>
      <dt>시작</dt><dd>${formatDateTime(event.start)}</dd>
      <dt>종료</dt><dd>${event.end ? formatDateTime(event.end) : '당일 일정'}</dd>
    </dl>
    ${event.url ? `<a class="source-link" href="${event.url}" target="_blank" rel="noreferrer">원본 일정 확인</a>` : ''}
  `;
  dialog.showModal();
}

function escapeHtml(text = '') {
  return text.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function render() {
  const year = state.cursor.getFullYear();
  const month = state.cursor.getMonth();
  monthLabel.textContent = `${year}년 ${String(month + 1).padStart(2, '0')}월`;
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  const today = dateKey(new Date());
  grid.innerHTML = '';

  for (let i = 0; i < 42; i += 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const events = visibleEventsFor(date);
    const cell = document.createElement('article');
    cell.className = `day-cell${date.getMonth() !== month ? ' outside' : ''}${dateKey(date) === today ? ' today' : ''}`;
    cell.setAttribute('aria-label', `${date.getMonth() + 1}월 ${date.getDate()}일, 일정 ${events.length}개`);
    cell.innerHTML = `<span class="day-number">${date.getDate()}</span><div class="events"></div>`;
    const list = cell.querySelector('.events');

    events.slice(0, 3).forEach((event) => {
      const button = document.createElement('button');
      button.className = `event ${event.game}`;
      button.type = 'button';
      button.innerHTML = `<span class="event-game">${GAME_LABELS[event.game]}</span><span class="event-title">${escapeHtml(event.title)}</span>`;
      button.addEventListener('click', () => openEvent(event));
      list.append(button);
    });

    if (events.length > 3) {
      const more = document.createElement('button');
      more.className = 'more-events';
      more.type = 'button';
      more.textContent = `+${events.length - 3}개 더보기`;
      more.addEventListener('click', () => openEvent(events[3]));
      list.append(more);
    }
    grid.append(cell);
  }
}

async function loadEvents() {
  try {
    const response = await fetch(`data/events.json?v=${Date.now()}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.events = Array.isArray(data.events) ? data.events : [];
    updatedAt.textContent = data.updatedAt
      ? `${new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(data.updatedAt))} 갱신`
      : '갱신 시각 미정';
  } catch (error) {
    updatedAt.textContent = '일정 불러오기 실패';
    console.error(error);
  }
  render();
}

document.querySelector('#prevMonth').addEventListener('click', () => { state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth() - 1, 1); render(); });
document.querySelector('#nextMonth').addEventListener('click', () => { state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth() + 1, 1); render(); });
monthLabel.addEventListener('click', () => { state.cursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1); render(); });
document.querySelector('#closeDialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });

document.querySelectorAll('.filter').forEach((button) => {
  button.addEventListener('click', () => {
    const game = button.dataset.game;
    if (game === 'all') {
      const allOn = state.enabledGames.size === 3;
      state.enabledGames = allOn ? new Set() : new Set(['wuwa', 'hsr', 'zzz']);
    } else if (state.enabledGames.has(game)) {
      state.enabledGames.delete(game);
    } else {
      state.enabledGames.add(game);
    }
    document.querySelectorAll('.filter[data-game]:not([data-game="all"])').forEach((item) => item.classList.toggle('active', state.enabledGames.has(item.dataset.game)));
    document.querySelector('.filter[data-game="all"]').classList.toggle('active', state.enabledGames.size === 3);
    render();
  });
});

loadEvents();
