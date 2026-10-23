'use strict';

const SIZE = 15;
const COLS = 'ABCDEFGHIJKLMNO';
const CHESS_W = 9;
const CHESS_H = 10;
const GO_SIZE = 9;
const GO_COLS = 'ABCDEFGHJ';
const RED_NAMES = { K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵' };
const BLACK_NAMES = { K: '将', A: '士', B: '象', N: '马', R: '车', C: '炮', P: '卒' };

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  name: localStorage.getItem('gomoku:name') || '',
  token: localStorage.getItem('gomoku:token') || '',
  user: null,
  config: null,
  models: [],
  rooms: [],
  room: null,
  roomCode: null,
  playerId: null,
  sse: null,
  userSse: null,
  hover: null,
  geo: null,
  game: 'gomoku',
  selected: null,
  legalMoves: [],
  anim: null,
  animKey: '',
  frame: 0,
  pulseTimer: null,
  mode: 'pvp',
  engine: 'llm',
  pollTimer: null,
  errorCount: 0,
  toastTimer: null,
  chatOpen: false,
  chatSeen: 0,
  chatTotal: 0,
  friends: [],
  incoming: [],
  outgoing: [],
  dmOpen: null, // { id, username, avatar }
  dmMessages: [],
  dmUnread: {}
};

// ------------------------------------------------------------ 基础工具

async function api(path, options = {}) {
  const opts = { ...options };
  opts.headers = opts.headers || {};
  if (state.token) opts.headers['Authorization'] = `Bearer ${state.token}`;
  if (opts.body && typeof opts.body !== 'string') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const response = await fetch(`/api${path}`, opts);
  let data = {};
  try {
    data = await response.json();
  } catch {
    /* 空响应 */
  }
  if (!response.ok) {
    const error = new Error(data.error || `请求失败（${response.status}）`);
    error.status = response.status;
    error.data = data;
    // 登录态失效：清 token 并跳回登录
    if (response.status === 401) {
      logout(false);
    }
    throw error;
  }
  return data;
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

const playerName = () => (state.name || '匿名棋手').trim() || '匿名棋手';

function setView(name) {
  const lobby = $('#lobbyView');
  const room = $('#roomView');
  const isLobby = name === 'lobby';
  lobby.classList.toggle('hidden', !isLobby);
  room.classList.toggle('hidden', isLobby);
  if (isLobby) startPolling();
  else stopPolling();
}

// ------------------------------------------------------------ 配置 / 设置

async function loadConfig() {
  try {
    const data = await api('/config');
    state.config = data;
    renderKeyState();
    updateEngineAvailability();
  } catch {
    $('#keyState').className = 'keyState warn';
    $('#keyState span').textContent = '服务未连接';
  }
}

function renderKeyState() {
  const el = $('#keyState');
  const hasKey = Boolean(state.config && state.config.hasKey);
  const providerName = (state.config?.providerList || []).find((p) => p.id === state.config?.provider)?.name || '大模型';
  el.className = `keyState ${hasKey ? 'ok' : 'warn'}`;
  el.querySelector('span').textContent = hasKey ? `${providerName} 已配置` : '未配置 Key';
  el.title = hasKey ? `${providerName} 密钥：${state.config.keyMasked}` : `尚未配置 ${providerName} API Key`;
}

function updateEngineAvailability() {
  const note = $('#engineNote');
  if (!note) return;
  const hasKey = Boolean(state.config && state.config.hasKey);
  const providerName = (state.config?.providerList || []).find((p) => p.id === state.config?.provider)?.name || '大模型';
  note.textContent = hasKey
    ? `由 ${providerName} 模型落子，失败时自动切换本地引擎。`
    : '未检测到 API Key，人机对战将使用本地引擎。可在右上角「设置」中配置。';
}

function currentProviderMeta() {
  const list = state.config?.providerList || [];
  return list.find((p) => p.id === state.config?.provider) || list[0] || null;
}

async function loadModels() {
  let models = [];
  try {
    const data = await api('/models');
    models = data.models || [];
  } catch {
    models = [];
  }
  state.models = models;
  const select = $('#modelSelect');
  select.innerHTML = models
    .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`)
    .join('');
  const cfg = state.config || {};
  const model = cfg.model || '';
  if (model) {
    if (!models.some((m) => m.id === model)) {
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      select.appendChild(option);
    }
    select.value = model;
    $('#modelInput').value = model;
    $('#modelInput').placeholder = model;
  }
}

function renderProviderSelect() {
  const list = state.config?.providerList || [];
  const select = $('#providerSelect');
  if (!select) return;
  select.innerHTML = list.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
  select.value = state.config?.provider || 'openrouter';
}

function applyProviderUI() {
  const meta = currentProviderMeta();
  if (!meta) return;
  $('#apiKeyInput').placeholder = meta.keyPlaceholder || 'sk-…';
  $('#apiKeyLabel').textContent = `${meta.name} API Key`;
  const cur = state.config || {};
  const hasKey = cur.hasKey;
  $('#apiKeyInput').value = '';
  $('#apiKeyInput').placeholder = hasKey ? cur.keyMasked : (meta.keyPlaceholder || 'sk-…');
  $('#baseURLInput').value = cur.baseURL || meta.baseURL || '';
  $('#baseURLInput').placeholder = meta.baseURL || 'https://…/v1';
}

function openSettings() {
  $('#settingsModal').classList.remove('hidden');
  const cfg = state.config || {};
  const meta = currentProviderMeta();
  const note = $('#currentKeyNote');
  note.textContent = cfg.hasKey ? `当前密钥（${meta?.name || ''}）：${cfg.keyMasked}` : '当前未配置密钥，将使用本地引擎。';
  renderProviderSelect();
  applyProviderUI();
  $('#modelInput').value = cfg.model || '';
  $('#testResult').textContent = '';
  $('#testResult').className = 'testResult';
  // 隐私设置
  const priv = state.user?.privacy || {};
  $('#privLobby').checked = priv.showAvatarInLobby !== false;
  $('#privLeaderboard').checked = priv.showAvatarInLeaderboard !== false;
}

function closeSettings() {
  $('#settingsModal').classList.add('hidden');
}

async function savePrivacy() {
  try {
    const data = await api('/auth/privacy', {
      method: 'PUT',
      body: {
        showAvatarInLobby: $('#privLobby').checked,
        showAvatarInLeaderboard: $('#privLeaderboard').checked
      }
    });
    if (state.user) state.user = data.user;
    toast('隐私设置已保存');
  } catch (err) {
    toast(err.message);
  }
}

// ---------------- 排行榜 ----------------
let lbState = { game: 'gomoku', period: 'daily' };
async function loadLeaderboard() {
  try {
    const data = await api(`/leaderboard?period=${lbState.period}&game=${lbState.game}`);
    renderLeaderboard(data.rows || []);
  } catch (err) {
    $('#lbList').innerHTML = '<div class="emptyState">加载失败</div>';
  }
}
function renderLeaderboard(rows) {
  const list = $('#lbList');
  if (!rows.length) {
    list.innerHTML = '<div class="emptyState">暂无数据，快去赢一局吧</div>';
    return;
  }
  const medals = ['🥇', '🥈', '🥉'];
  list.innerHTML = rows.map((r, i) => {
    const rank = i < 3 ? `<span class="lbMedal">${medals[i]}</span>` : `<span class="lbRank">${i + 1}</span>`;
    const a = r.avatar;
    const avatarInner = a && (a.startsWith('http') || a.startsWith('data:'))
      ? `<img src="${escapeHtml(a)}" alt="">`
      : `<span>${escapeHtml(a || '👤')}</span>`;
    return `<div class="lbRow">
      ${rank}
      <div class="lbAvatar">${avatarInner}</div>
      <span class="lbName">${escapeHtml(r.username)}</span>
      <span class="lbWins">${r.wins} 胜</span>
    </div>`;
  }).join('');
}
function openLeaderboard() {
  $('#leaderboardModal').classList.remove('hidden');
  loadLeaderboard();
}

async function saveSettings() {
  const provider = $('#providerSelect').value || 'openrouter';
  const apiKey = $('#apiKeyInput').value.trim();
  const baseURL = $('#baseURLInput').value.trim();
  const model = $('#modelInput').value.trim() || $('#modelSelect').value;
  try {
    const data = await api('/config', {
      method: 'POST',
      body: { provider, providers: { [provider]: { apiKey, baseURL, model } } }
    });
    state.config = { ...(state.config || {}), ...data };
    renderKeyState();
    updateEngineAvailability();
    closeSettings();
    toast('设置已保存');
  } catch (err) {
    toast(err.message);
  }
}

async function testKey() {
  const btn = $('#testKeyBtn');
  const result = $('#testResult');
  btn.disabled = true;
  result.className = 'testResult';
  result.textContent = '正在测试…';

  const provider = $('#providerSelect').value || 'openrouter';
  const typedKey = $('#apiKeyInput').value.trim();
  const baseURL = $('#baseURLInput').value.trim();
  if (typedKey || baseURL) {
    try {
      await api('/config', {
        method: 'POST',
        body: { provider, providers: { [provider]: { apiKey: typedKey, baseURL } } }
      });
      await loadConfig();
    } catch (err) {
      result.className = 'testResult bad';
      result.textContent = err.message;
      btn.disabled = false;
      return;
    }
  }

  try {
    const data = await api('/config/test', { method: 'POST' });
    if (data.ok) {
      const parts = ['连接正常'];
      if (data.label) parts.push(data.label);
      if (data.freeTier) parts.push('免费额度账号');
      if (data.freeRemaining !== null && data.freeRemaining !== undefined) {
        parts.push(`今日免费模型剩余 ${data.freeRemaining}/${data.freeLimit}`);
      }
      if (data.usage !== undefined) parts.push(`累计消费 $${Number(data.usage).toFixed(4)}`);
      result.className = 'testResult ok';
      result.textContent = parts.join(' · ');
      await loadModels();
      const model = (state.config && state.config.model) || $('#modelSelect').value;
      if (model) $('#modelInput').value = model;
    } else {
      result.className = 'testResult bad';
      result.textContent = data.error || '测试失败';
    }
  } catch (err) {
    result.className = 'testResult bad';
    result.textContent = err.message;
  }
  btn.disabled = false;
}

async function clearKey() {
  if (!window.confirm('确定清除当前供应商的 API Key？')) return;
  const provider = $('#providerSelect').value || 'openrouter';
  try {
    await api('/config', {
      method: 'POST',
      body: { provider, providers: { [provider]: { clearKey: true, apiKey: '' } } }
    });
    await loadConfig();
    applyProviderUI();
    $('#currentKeyNote').textContent = '已清除，人机对战将使用本地引擎。';
    $('#testResult').className = 'testResult';
    $('#testResult').textContent = '密钥已清除';
    toast('密钥已清除');
  } catch (err) {
    toast(err.message);
  }
}

// ------------------------------------------------------------ 大厅

function startPolling() {
  stopPolling();
  loadRooms();
  state.pollTimer = setInterval(() => {
    if (!$('#lobbyView').classList.contains('hidden')) loadRooms();
  }, 4000);
}

function stopPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function loadRooms() {
  try {
    const data = await api('/rooms');
    state.rooms = data.rooms || [];
    renderRooms();
  } catch {
    const list = $('#roomList');
    if (!state.rooms.length) {
      list.innerHTML = '<div class="emptyState">无法连接服务，请稍后重试</div>';
    }
  }
}

function roomStatusBadge(room) {
  if (room.status === 'playing') return '<span class="badge live">对局中</span>';
  if (room.status === 'waiting') return '<span class="badge wait">等待中</span>';
  return '<span class="badge done">已结束</span>';
}

function renderRooms() {
  const list = $('#roomList');
  const rooms = state.rooms.filter((r) => r.status !== 'finished');
  const active = state.rooms.filter((r) => r.status !== 'finished');
  $('#statRooms').textContent = String(active.length);
  $('#statPlayers').textContent = String(
    active.reduce((sum, r) => sum + (r.humanCount || 0), 0)
  );

  if (!rooms.length) {
    list.innerHTML = '<div class="emptyState">大厅里还没有对局，创建第一间房吧</div>';
    return;
  }

  list.innerHTML = rooms
    .map((room) => {
      const gameBadge = room.game === 'chess'
        ? '<span class="badge chess">象棋</span>'
        : room.game === 'go'
          ? '<span class="badge go">围棋</span>'
          : '<span class="badge">五子棋</span>';
      const modeBadge = room.mode === 'ai'
        ? `<span class="badge ai">人机${room.aiEngine === 'local' ? ' · 本地' : ' · 模型'}</span>`
        : '<span class="badge">双人</span>';
      const canJoin = room.status === 'waiting' && room.humanCount < 2;
      const avatars = (room.playerInfo || []).map((p) => {
        const a = p.avatar;
        const inner = a && (a.startsWith('http') || a.startsWith('data:'))
          ? `<img src="${escapeHtml(a)}" alt="">`
          : `<span>${escapeHtml(a || '👤')}</span>`;
        return `<div class="rAvatar" title="${escapeHtml(p.name)}">${inner}</div>`;
      }).join('');
      return `
        <div class="roomRow">
          <span class="rc">${escapeHtml(room.code)}</span>
          <div class="rmain">
            <b>${escapeHtml(room.name)}</b>
            <span>${room.humanCount}/2 位棋手 · ${room.mode === 'ai' ? 'AI 已就位' : '等待另一位棋手'}</span>
          </div>
          <div class="rAvatars">${avatars}</div>
          <div class="rside">
            ${gameBadge}
            ${modeBadge}
            ${roomStatusBadge(room)}
            <button class="ghostBtn small" data-join="${escapeHtml(room.code)}" type="button">
              ${canJoin || room.mode === 'ai' ? '加入' : '观战'}
            </button>
          </div>
        </div>`;
    })
    .join('');
}

// ------------------------------------------------------------ 房间进出

async function createRoom(event) {
  event.preventDefault();
  const btn = $('#createBtn');
  btn.disabled = true;
  try {
    const data = await api('/rooms', {
      method: 'POST',
      body: {
        name: $('#roomNameInput').value.trim() || `${playerName()}的${state.game === 'chess' ? '棋局' : state.game === 'go' ? '围棋' : '五子棋'}`,
        game: state.game,
        mode: state.mode,
        aiEngine: state.engine,
        playerName: playerName()
      }
    });
    localStorage.setItem('gomoku:name', state.name);
    localStorage.setItem(`gomoku:pid:${data.room.code}`, data.playerId);
    enterRoom(data.room, data.playerId);
  } catch (err) {
    toast(err.message);
  }
  btn.disabled = false;
}

async function joinRoom(code, options = {}) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return;
  const stored = localStorage.getItem(`gomoku:pid:${normalized}`) || '';
  try {
    const data = await api(`/rooms/${normalized}/join`, {
      method: 'POST',
      body: { playerName: playerName(), playerId: stored }
    });
    localStorage.setItem(`gomoku:pid:${normalized}`, data.playerId);
    enterRoom(data.room, data.playerId);
  } catch (err) {
    if (err.status === 409) {
      // 房间已满：以观战身份进入
      toast('房间已满，已切换为观战');
      enterRoom({ code: normalized, status: 'playing' }, '');
      return;
    }
    if (options.silent) return;
    toast(err.message);
  }
}

function enterRoom(room, playerId) {
  state.roomCode = room.code;
  state.playerId = playerId || '';
  state.hover = null;
  state.selected = null;
  state.legalMoves = [];
  state.anim = null;
  state.animKey = '';
  state.chatOpen = false;
  state.chatSeen = 0;
  state.chatTotal = 0;
  $('#chatBox').classList.add('hidden');
  $('#chatList').innerHTML = '';
  $('#chatToggle').classList.remove('active');
  $('#chatBadge').classList.add('hidden');
  setView('room');
  window.scrollTo({ top: 0, behavior: 'auto' });
  $('#roomCodeLabel').textContent = room.code;
  $('#roomNameLabel').textContent = room.name || '';
  if (location.hash !== `#/room/${room.code}`) {
    history.pushState(null, '', `#/room/${room.code}`);
  }
  openStream(room.code, state.playerId);
  if (room.board) {
    state.room = room;
    renderRoom();
  }
}

function openStream(code, playerId) {
  closeStream();
  const url = `/api/rooms/${code}/events?playerId=${encodeURIComponent(playerId || '')}`;
  const es = new EventSource(url);
  state.sse = es;
  state.errorCount = 0;

  es.addEventListener('state', (event) => {
    state.errorCount = 0;
    try {
      const room = JSON.parse(event.data);
      state.room = room;
      state.roomCode = room.code;
      if (room.messages) {
        syncChatHistory(room.messages);
      }
      renderRoom();
    } catch {
      /* 忽略错误数据 */
    }
  });

  es.addEventListener('chat', (event) => {
    try {
      const msg = JSON.parse(event.data);
      appendChat(msg);
    } catch {
      /* 忽略 */
    }
  });

  es.onerror = () => {
    state.errorCount += 1;
    const status = $('#statusText');
    if (status) status.textContent = '连接中断，正在重连…';
    if (state.errorCount >= 3) {
      api(`/rooms/${code}`)
        .then((data) => {
          state.room = data.room;
          state.errorCount = 0;
        })
        .catch((err) => {
          if (err.status === 404) {
            closeStream();
            toast('房间已不存在');
            goLobby();
          }
        });
    }
  };
}

function closeStream() {
  if (state.sse) {
    state.sse.close();
    state.sse = null;
  }
}

async function leaveRoom({ silent } = {}) {
  if (state.roomCode && state.playerId) {
    try {
      await api(`/rooms/${state.roomCode}/leave`, {
        method: 'POST',
        body: { playerId: state.playerId }
      });
    } catch {
      /* 忽略 */
    }
  }
  closeStream();
  state.room = null;
  state.roomCode = null;
  state.playerId = null;
  if (!silent) {
    history.pushState(null, '', '#/');
    goLobby();
  }
}

function goLobby() {
  setView('lobby');
  $('#rejoinLink').classList.add('hidden');
  loadRooms();
}

// ------------------------------------------------------------ 房间渲染

function myPlayer(room) {
  if (!state.playerId) return null;
  return room.players.find((p) => p.id === state.playerId) || null;
}

function isMyTurn(room) {
  const me = myPlayer(room);
  return Boolean(me && room.status === 'playing' && room.turn === me.color);
}

function renderRoom() {
  const room = state.room;
  if (!room || !room.players) return;

  if (state.roomCode !== room.code) return;
  $('#roomCodeLabel').textContent = room.code;
  $('#roomNameLabel').textContent = room.name || '';

  const isChess = room.game === 'chess';
  const isGo = room.game === 'go';
  $('.boardWrap').classList.toggle('chess', isChess);
  $('.boardWrap').classList.toggle('go', isGo);
  $('#board').setAttribute('aria-label', isChess ? '中国象棋棋盘' : isGo ? '围棋棋盘' : '五子棋棋盘');

  // 轮到别人走棋时，清掉自己的选中态
  if (!isMyTurn(room) || room.status !== 'playing') {
    state.selected = null;
    state.legalMoves = [];
  }
  if (isChess) ensureChessAnim(room);
  else state.anim = null;

  renderPlayers(room);
  renderStatus(room);
  renderSide(room);
  renderActions(room);
  drawBoard();
}

function renderPlayers(room) {
  const me = myPlayer(room);
  const first = room.players.find((p) => p.color === 1);
  const second = room.players.find((p) => p.color === 2);
  const isChess = room.game === 'chess';

  const fill = (el, player, label, color) => {
    const active = room.status === 'playing' && room.turn === color;
    el.classList.toggle('active', Boolean(active));
    el.classList.toggle('self', Boolean(me && player && player.id === me.id));
    el.querySelector('.playerMeta b').textContent = player ? player.name : label;
    let sub = '等待棋手';
    if (player) {
      sub = player.isAI ? '人机棋手' : (player.connected ? '已连接' : '暂时离线');
      if (room.game === 'go' && room.board) {
        sub += ` · 提子 ${room.board.captures?.[color] || 0}`;
      }
    }
    el.querySelector('.playerMeta span').textContent = sub;

    const icon = el.querySelector('.stoneIcon');
    icon.className = `stoneIcon ${isChess ? (color === 1 ? 'red' : 'chessBlack') : (color === 1 ? 'black' : 'white')}`;
    icon.textContent = isChess ? (color === 1 ? '帅' : '将') : '';
  };

  fill($('#blackCard'), first, isChess ? '红方' : '黑棋', 1);
  fill($('#whiteCard'), second, isChess ? '黑方' : '白棋', 2);
}

function statusLabel(room) {
  const chess = room.game === 'chess';
  const go = room.game === 'go';

  if (room.status === 'waiting') {
    return '等待对手加入，把房间码发给朋友即可开始';
  }

  if (room.status === 'playing') {
    if (chess && room.check) {
      return isMyTurn(room) ? '将军！你必须应将' : '将军！对方正在应将';
    }
    if (go && room.board?.passes === 1) {
      return isMyTurn(room) ? '对方停一手，你也可以停一手结束对局' : '你已停一手，等待对方落子';
    }
    if (isMyTurn(room)) return chess ? '轮到你走棋' : go ? '轮到你落子' : '轮到你落子';
    if (room.ai && room.ai.thinking) return go ? 'AI 正在思考…' : 'AI 正在思考…';
    if (room.ai) return go ? '等待 AI 落子' : '等待 AI 落子';
    return chess ? '等待对手走棋' : go ? '等待对手落子' : '等待对手落子';
  }

  if (room.draw) return '本局平局';
  if (!room.winner) return '对局已结束';

  if (go) {
    const colorName = room.winner === 1 ? '黑棋' : '白棋';
    const s = room.board?.score;
    const diff = s ? Math.abs(s.diff).toFixed(1) : '';
    const reason = room.winReason === 'resign'
      ? '对方认输'
      : (diff ? `胜 ${diff} 目` : '点目胜');
    const me = myPlayer(room);
    if (me) return room.winner === me.color ? `你赢了 · ${colorName}${reason}` : `你输了 · ${colorName}${reason}`;
    return `${colorName}${reason}`;
  }

  const colorName = chess ? (room.winner === 1 ? '红方' : '黑方') : (room.winner === 1 ? '黑棋' : '白棋');
  const reason = chess ? (room.winReason === 'checkmate' ? '绝杀' : '擒王') : '五连';
  const me = myPlayer(room);
  if (me) {
    return room.winner === me.color ? `你赢了 · ${colorName}${reason}` : `你输了 · ${colorName}${reason}`;
  }
  return `${colorName}获胜 · ${reason}`;
}

function renderStatus(room) {
  const mine = isMyTurn(room);
  $('#statusText').textContent = statusLabel(room);
  const dot = $('#statusDot');
  dot.className = 'statusDot';
  if (room.status === 'finished') dot.classList.add('over');
  else if (!mine) dot.classList.add('wait');

  const note = $('#aiNote');
  if (room.mode === 'ai') {
    const engine = room.ai?.engine === 'local' ? '本地引擎' : 'OpenRouter 模型';
    const parts = [`AI · ${engine}`];
    if (room.ai?.thinking) parts.push('思考中');
    if (room.ai?.source === 'llm') parts.push('本步由模型给出');
    if (room.ai?.source === 'local' && room.moves.length) parts.push('本步由本地引擎给出');
    if (room.ai?.autoNote) parts.push(room.ai.autoNote);
    if (room.ai?.error) parts.push(room.ai.error);
    note.textContent = parts.join(' · ');
  } else {
    note.textContent = '';
  }

  const banner = $('#boardBanner');
  if (room.status === 'waiting') {
    banner.innerHTML = `<b>等待对手加入</b><br>房间码 ${escapeHtml(room.code)}<br><span style="color:#9aa2b3;font-size:12px">把链接分享给朋友</span>`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

function renderSide(room) {
  const me = myPlayer(room);
  const isChess = room.game === 'chess';
  const isGo = room.game === 'go';
  $('#infoRoom').textContent = room.code;
  $('#infoMode').textContent = `${isChess ? '象棋' : isGo ? '围棋' : '五子棋'} · ${room.mode === 'ai' ? '人机' : '双人'}`;
  $('#infoMoves').textContent = String(room.moves.length);
  $('#infoStatus').textContent =
    room.status === 'waiting' ? '等待对手' : room.status === 'playing' ? (room.check ? '将军' : '进行中') : '已结束';
  $('#infoSpectators').textContent = String(room.spectators || 0);

  const people = room.players.map((p) => {
    const isMe = me && p.id === me.id;
    const role = p.isAI ? '<span class="role">AI</span>' : isMe ? '<span class="role">我</span>' : '';
    const presence = p.isAI
      ? '<span class="presence on">在线</span>'
      : `<span class="presence ${p.connected ? 'on' : ''}">${p.connected ? '在线' : '离线'}</span>`;
    let icon;
    if (isChess) {
      icon = `<i class="stoneIcon ${p.color === 1 ? 'red' : 'chessBlack'}">${p.color === 1 ? '帅' : '将'}</i>`;
    } else {
      icon = `<i class="stoneIcon ${p.color === 1 ? 'black' : 'white'}"></i>`;
    }
    return `<li>
      ${icon}
      <span>${escapeHtml(p.name)}</span>${role}${presence}
    </li>`;
  });
  if (room.spectators > 0) {
    people.push(`<li><span>观战者</span><span class="presence on">${room.spectators} 人</span></li>`);
  }
  $('#peopleList').innerHTML = people.join('');

  const moves = room.moves.slice(-40).reverse();
  if (!moves.length) {
    $('#moveList').innerHTML = `<li style="color:#6b7385">还没有${isChess ? '走棋' : isGo ? '落子' : '落子'}</li>`;
  } else if (isGo) {
    $('#moveList').innerHTML = moves
      .map((m) => {
        const no = room.moves.indexOf(m) + 1;
        const src = m.by === 'ai' ? 'AI' : '';
        const label = m.pass ? '停一手' : `${GO_COLS[m.x] || '?'}${m.y + 1}${m.captures ? ` 提${m.captures}` : ''}`;
        return `<li><span class="mn">${no}</span><i class="mc ${m.color === 1 ? 'b' : 'w'}"></i><span>${label}</span><span class="msrc">${src}</span></li>`;
      })
      .join('');
  } else {
    $('#moveList').innerHTML = moves
      .map((m) => {
        const no = room.moves.indexOf(m) + 1;
        if (isChess) {
          const name = (m.color === 1 ? RED_NAMES : BLACK_NAMES)[String(m.piece || '').toUpperCase()] || '';
          const label = `${name} ${m.fromX}·${m.fromY} → ${m.toX}·${m.toY}`;
          const src = m.source === 'llm' ? 'LLM' : m.by === 'ai' ? 'AI' : '';
          return `<li><span class="mn">${no}</span><i class="mc ${m.color === 1 ? 'r' : 'bk'}"></i><span>${label}</span><span class="msrc">${src}</span></li>`;
        }
        const label = `${COLS[m.x]}${m.y + 1}`;
        const src = m.source === 'llm' ? 'LLM' : m.by === 'ai' ? 'AI' : '';
        return `<li><span class="mn">${no}</span><i class="mc ${m.color === 1 ? 'b' : 'w'}"></i><span>${label}</span><span class="msrc">${src}</span></li>`;
      })
      .join('');
  }
}

function renderActions(room) {
  const me = myPlayer(room);
  const resign = $('#resignBtn');
  const rematch = $('#rematchBtn');

  resign.disabled = !me || room.status !== 'playing';
  resign.textContent = '认输';

  const canRematch = Boolean(me) && room.status === 'finished' && (room.mode === 'ai' || room.players.filter((p) => !p.isAI).length === 2);
  rematch.disabled = !canRematch;

  const pass = $('#passBtn');
  if (pass) {
    const showPass = room.game === 'go' && room.status === 'playing' && Boolean(me) && room.turn === me.color;
    pass.classList.toggle('hidden', !showPass);
  }

  const rejoin = $('#rejoinLink');
  rejoin.classList.toggle('hidden', Boolean(me) || !state.roomCode);
  if (!me && state.roomCode) {
    rejoin.href = `#/room/${state.roomCode}`;
  }
}

async function rejoinAsPlayer(event) {
  event.preventDefault();
  if (!state.roomCode) return;
  await joinRoom(state.roomCode);
}

// ------------------------------------------------------------ 聊天

function chatTime(at) {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderChatMessage(msg, mine) {
  const me = state.playerId && msg.playerId === state.playerId;
  const isChess = state.room && state.room.game === 'chess';
  const colorClass = isChess
    ? (msg.color === 1 ? 'r' : 'bk')
    : (msg.color === 1 ? 'b' : 'w');
  return `<li class="chatMsg ${me ? 'self' : ''}">
    <div class="chatMeta"><b class="c-${colorClass}">${escapeHtml(msg.name)}</b><time>${chatTime(msg.at)}</time></div>
    <div class="chatText">${escapeHtml(msg.text)}</div>
  </li>`;
}

function appendChat(msg) {
  const list = $('#chatList');
  if (!list) return;
  const existing = Array.from(list.children);
  if (existing.some((li) => li.dataset.id === msg.id)) return;
  const li = document.createElement('li');
  li.className = `chatMsg ${msg.playerId === state.playerId ? 'self' : ''}`;
  li.dataset.id = msg.id;
  li.innerHTML = `
    <div class="chatMeta"><b>${escapeHtml(msg.name)}</b><time>${chatTime(msg.at)}</time></div>
    <div class="chatText">${escapeHtml(msg.text)}</div>`;
  list.appendChild(li);
  state.chatTotal += 1;
  if (state.chatOpen) {
    state.chatSeen = state.chatTotal;
    list.scrollTop = list.scrollHeight;
  }
  updateChatBadge();
}

function setChatHistory(messages) {
  const list = $('#chatList');
  if (!list) return;
  list.innerHTML = (messages || []).map((m) => renderChatMessage(m)).join('');
  state.chatTotal = (messages || []).length;
  if (state.chatOpen) {
    state.chatSeen = state.chatTotal;
    list.scrollTop = list.scrollHeight;
  }
  updateChatBadge();
}

function syncChatHistory(messages) {
  // 从 state 同步历史（仅在列表为空时填充，避免和 chat 事件重复）
  const list = $('#chatList');
  if (list && !list.children.length) {
    setChatHistory(messages);
  } else {
    state.chatTotal = Math.max(state.chatTotal, (messages || []).length);
    updateChatBadge();
  }
}

function updateChatBadge() {
  const badge = $('#chatBadge');
  if (!badge) return;
  const unseen = state.chatOpen ? 0 : Math.max(0, state.chatTotal - state.chatSeen);
  badge.textContent = String(unseen);
  badge.classList.toggle('hidden', unseen === 0);
}

function toggleChat() {
  state.chatOpen = !state.chatOpen;
  const box = $('#chatBox');
  const btn = $('#chatToggle');
  box.classList.toggle('hidden', !state.chatOpen);
  btn.setAttribute('aria-expanded', String(state.chatOpen));
  btn.classList.toggle('active', state.chatOpen);
  if (state.chatOpen) {
    state.chatSeen = state.chatTotal;
    const list = $('#chatList');
    if (list) list.scrollTop = list.scrollHeight;
    $('#chatInput').focus();
  }
  updateChatBadge();
}

async function sendChat(event) {
  event.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text || !state.roomCode || !state.playerId) return;
  input.value = '';
  try {
    await api(`/rooms/${state.roomCode}/chat`, {
      method: 'POST',
      body: { playerId: state.playerId, text }
    });
  } catch (err) {
    toast(err.message);
  }
}

// ------------------------------------------------------------ 棋盘绘制

function boardMetrics() {
  const canvas = $('#board');
  const rect = canvas.getBoundingClientRect();
  const size = rect.width;
  const pad = size * 0.044;
  const step = (size - pad * 2) / (SIZE - 1);
  return { canvas, rect, size, pad, step };
}

function drawBoard() {
  const room = state.room;
  if (!room || !room.board) return;
  const canvas = $('#board');
  if (!canvas.getBoundingClientRect().width) return;
  if (room.game === 'chess') drawChessBoard();
  else if (room.game === 'go') drawGoBoard();
  else drawGomokuBoard();
}

function drawGomokuBoard() {
  const room = state.room;
  if (!room || !room.board) return;
  const canvas = $('#board');
  if (!canvas.getBoundingClientRect().width) return;

  const { rect, size, pad, step } = boardMetrics();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const px = Math.round(rect.width * dpr);
  if (canvas.width !== px || canvas.height !== px) {
    canvas.width = px;
    canvas.height = px;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const pos = (i) => pad + i * step;

  // 网格
  ctx.strokeStyle = 'rgba(76, 45, 16, 0.58)';
  ctx.lineWidth = Math.max(1, size * 0.0015);
  ctx.beginPath();
  for (let i = 0; i < SIZE; i++) {
    const p = pos(i);
    ctx.moveTo(pad, p);
    ctx.lineTo(size - pad, p);
    ctx.moveTo(p, pad);
    ctx.lineTo(p, size - pad);
  }
  ctx.stroke();

  // 星位
  const stars = [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]];
  ctx.fillStyle = 'rgba(62, 36, 12, 0.85)';
  for (const [sx, sy] of stars) {
    ctx.beginPath();
    ctx.arc(pos(sx), pos(sy), Math.max(1.8, size * 0.006), 0, Math.PI * 2);
    ctx.fill();
  }

  const radius = step * 0.44;
  const board = room.board;

  // 棋子
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const value = board[y * SIZE + x];
      if (!value) continue;
      drawStone(ctx, pos(x), pos(y), radius, value === 1);
    }
  }

  // 最后一手标记
  const last = room.moves[room.moves.length - 1];
  if (last) {
    ctx.beginPath();
    ctx.arc(pos(last.x), pos(last.y), Math.max(2, radius * 0.2), 0, Math.PI * 2);
    ctx.fillStyle = last.color === 1 ? '#e8c07a' : '#c0392b';
    ctx.fill();
  }

  // 悬停预览
  if (state.hover && !isOccupied(board, state.hover.x, state.hover.y) && isMyTurn(room)) {
    const me = myPlayer(room);
    ctx.globalAlpha = 0.32;
    drawStone(ctx, pos(state.hover.x), pos(state.hover.y), radius, me.color === 1);
    ctx.globalAlpha = 1;
  }

  // 五连高亮
  if (room.winLine && room.winLine.length) {
    const points = room.winLine;
    const a = points[0];
    const b = points[points.length - 1];
    ctx.strokeStyle = 'rgba(242, 119, 122, 0.9)';
    ctx.lineWidth = Math.max(2, radius * 0.28);
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(242, 119, 122, 0.7)';
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.moveTo(pos(a[0]), pos(a[1]));
    ctx.lineTo(pos(b[0]), pos(b[1]));
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  canvas.classList.toggle('readonly', !isMyTurn(room));
  state.geo = { pad, step, size };
}

function drawStone(ctx, cx, cy, r, isBlack) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx + r * 0.12, cy + r * 0.2, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(48, 28, 8, 0.28)';
  ctx.filter = 'blur(2px)';
  ctx.fill();
  ctx.restore();

  const gradient = ctx.createRadialGradient(
    cx - r * 0.34,
    cy - r * 0.38,
    r * 0.12,
    cx,
    cy,
    r
  );
  if (isBlack) {
    gradient.addColorStop(0, '#5e6674');
    gradient.addColorStop(0.42, '#262b34');
    gradient.addColorStop(1, '#07090c');
  } else {
    gradient.addColorStop(0, '#ffffff');
    gradient.addColorStop(0.55, '#f4f6fa');
    gradient.addColorStop(1, '#bcc3cf');
  }
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = isBlack ? 'rgba(255, 255, 255, 0.08)' : 'rgba(90, 100, 115, 0.25)';
  ctx.lineWidth = 0.8;
  ctx.stroke();
}

// ------------------------------------------------------------ 围棋绘制

function goMetrics() {
  const canvas = $('#board');
  const rect = canvas.getBoundingClientRect();
  const size = Math.min(rect.width, rect.height);
  const pad = size * 0.082;
  const step = (size - pad * 2) / (GO_SIZE - 1);
  return { canvas, rect, size, pad, step, ox: (rect.width - size) / 2, oy: (rect.height - size) / 2 };
}

function drawGoBoard() {
  const room = state.room;
  if (!room || !room.board) return;
  const canvas = $('#board');
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pw = Math.max(1, Math.round(rect.width * dpr));
  const ph = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const { size, pad, step, ox, oy } = goMetrics();
  ctx.drawImage(woodTexture(rect.width, rect.height, dpr), 0, 0, rect.width, rect.height);

  const X = (i) => ox + pad + i * step;
  const Y = (i) => oy + pad + i * step;
  const radius = step * 0.465;
  const grid = room.board.grid || [];

  // 外框
  const margin = step * 0.62;
  ctx.save();
  ctx.strokeStyle = 'rgba(72, 40, 12, 0.55)';
  ctx.lineWidth = Math.max(2, step * 0.07);
  ctx.strokeRect(X(0) - margin, Y(0) - margin, step * (GO_SIZE - 1) + margin * 2, step * (GO_SIZE - 1) + margin * 2);
  ctx.strokeStyle = 'rgba(255, 243, 216, 0.32)';
  ctx.lineWidth = Math.max(1, step * 0.02);
  ctx.strokeRect(X(0) - margin * 0.82, Y(0) - margin * 0.82, step * (GO_SIZE - 1) + margin * 1.64, step * (GO_SIZE - 1) + margin * 1.64);
  ctx.restore();

  // 网格
  ctx.save();
  ctx.strokeStyle = 'rgba(60, 34, 10, 0.78)';
  ctx.lineWidth = Math.max(1, step * 0.028);
  ctx.lineCap = 'round';
  for (let i = 0; i < GO_SIZE; i++) {
    ctx.beginPath();
    ctx.moveTo(X(0), Y(i));
    ctx.lineTo(X(GO_SIZE - 1), Y(i));
    ctx.moveTo(X(i), Y(0));
    ctx.lineTo(X(i), Y(GO_SIZE - 1));
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255, 245, 220, 0.22)';
  ctx.lineWidth = Math.max(0.8, step * 0.012);
  for (let i = 0; i < GO_SIZE; i++) {
    ctx.beginPath();
    ctx.moveTo(X(0), Y(i) + step * 0.03);
    ctx.lineTo(X(GO_SIZE - 1), Y(i) + step * 0.03);
    ctx.moveTo(X(i) + step * 0.03, Y(0));
    ctx.lineTo(X(i) + step * 0.03, Y(GO_SIZE - 1));
    ctx.stroke();
  }
  ctx.restore();

  // 星位
  ctx.fillStyle = 'rgba(48, 26, 8, 0.9)';
  for (const [sx, sy] of [[2, 2], [6, 2], [2, 6], [6, 6], [4, 4]]) {
    ctx.beginPath();
    ctx.arc(X(sx), Y(sy), Math.max(2, step * 0.055), 0, TAU);
    ctx.fill();
  }

  // 坐标
  const cha = GO_COLS.split('');
  ctx.save();
  ctx.fillStyle = 'rgba(72, 42, 16, 0.55)';
  ctx.font = `600 ${Math.max(9, step * 0.26)}px "PingFang SC", "Noto Sans SC", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < GO_SIZE; i++) {
    ctx.fillText(cha[i], X(i), Y(GO_SIZE - 1) + pad * 0.8);
    ctx.fillText(String(GO_SIZE - i), X(0) - pad * 0.8, Y(i));
  }
  ctx.restore();

  // 棋子
  for (let y = 0; y < GO_SIZE; y++) {
    for (let x = 0; x < GO_SIZE; x++) {
      const v = grid[y * GO_SIZE + x];
      if (!v) continue;
      drawStone(ctx, X(x), Y(y), radius, v === 1);
    }
  }

  // 劫点提示
  if (room.board.ko !== null && room.board.ko !== undefined && room.status === 'playing') {
    const kx = room.board.ko % GO_SIZE;
    const ky = Math.floor(room.board.ko / GO_SIZE);
    ctx.save();
    ctx.strokeStyle = 'rgba(212, 66, 48, 0.85)';
    ctx.lineWidth = Math.max(1.5, step * 0.035);
    const r = radius * 0.42;
    ctx.strokeRect(X(kx) - r, Y(ky) - r, r * 2, r * 2);
    ctx.restore();
  }

  // 最后一手标记
  const last = room.moves[room.moves.length - 1];
  if (last && !last.pass && last.x !== undefined) {
    ctx.beginPath();
    ctx.arc(X(last.x), Y(last.y), Math.max(2, radius * 0.22), 0, TAU);
    ctx.fillStyle = last.color === 1 ? '#f3d48b' : '#c0392b';
    ctx.fill();
  }

  // 悬停预览
  if (state.hover && room.status === 'playing' && isMyTurn(room)) {
    const i = state.hover.y * GO_SIZE + state.hover.x;
    if (!grid[i]) {
      const me = myPlayer(room);
      ctx.globalAlpha = 0.35;
      drawStone(ctx, X(state.hover.x), Y(state.hover.y), radius, me?.color !== 2);
      ctx.globalAlpha = 1;
    }
  }

  canvas.classList.toggle('readonly', !isMyTurn(room) || room.status !== 'playing');
  state.geo = { go: true, pad, step, size, ox, oy };
}

// ------------------------------------------------------------ 象棋绘制

const TAU = Math.PI * 2;
let woodCache = { key: '', canvas: null };

function chessMetrics() {
  const canvas = $('#board');
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  const padX = w * 0.072;
  const padY = h * 0.062;
  const step = Math.min((w - padX * 2) / 8, (h - padY * 2) / 9);
  return {
    canvas,
    rect,
    w,
    h,
    step,
    ox: (w - step * 8) / 2,
    oy: (h - step * 9) / 2
  };
}

function paintWood(g, w, h) {
  const base = g.createLinearGradient(0, 0, w, h);
  base.addColorStop(0, '#eccd9b');
  base.addColorStop(0.35, '#e0b982');
  base.addColorStop(0.7, '#cf9f63');
  base.addColorStop(1, '#bd8a4e');
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);

  const sheen = g.createRadialGradient(w * 0.22, h * 0.06, 0, w * 0.22, h * 0.06, Math.max(w, h) * 0.95);
  sheen.addColorStop(0, 'rgba(255, 248, 228, 0.55)');
  sheen.addColorStop(1, 'rgba(255, 248, 228, 0)');
  g.fillStyle = sheen;
  g.fillRect(0, 0, w, h);

  let seed = 987654321;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  for (let i = 0; i < 78; i++) {
    const baseY = rand() * h;
    const amp = h * (0.006 + rand() * 0.018);
    g.beginPath();
    g.moveTo(-20, baseY);
    for (let x = -20; x <= w + 20; x += Math.max(24, w / 7)) {
      g.quadraticCurveTo(x + w / 14, baseY + (rand() - 0.5) * amp * 2, x + w / 7, baseY + (rand() - 0.5) * amp);
    }
    g.strokeStyle = `rgba(${108 + rand() * 34}, ${64 + rand() * 22}, ${26 + rand() * 18}, ${0.02 + rand() * 0.05})`;
    g.lineWidth = 0.5 + rand() * 1.9;
    g.stroke();
  }

  for (let i = 0; i < 4; i++) {
    const kx = rand() * w;
    const ky = rand() * h;
    const kr = Math.min(w, h) * (0.03 + rand() * 0.05);
    g.save();
    g.translate(kx, ky);
    g.rotate(rand() * Math.PI);
    g.strokeStyle = 'rgba(112, 68, 28, 0.10)';
    g.lineWidth = 1;
    for (let r = kr * 0.35; r <= kr; r += kr * 0.22) {
      g.beginPath();
      g.ellipse(0, 0, r * 1.5, r, 0, 0, TAU);
      g.stroke();
    }
    g.restore();
  }

  const vignette = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.28, w / 2, h / 2, Math.max(w, h) * 0.8);
  vignette.addColorStop(0, 'rgba(90, 50, 18, 0)');
  vignette.addColorStop(0.78, 'rgba(90, 50, 18, 0.10)');
  vignette.addColorStop(1, 'rgba(72, 38, 10, 0.30)');
  g.fillStyle = vignette;
  g.fillRect(0, 0, w, h);
}

function woodTexture(w, h, dpr) {
  const key = `${Math.round(w)}:${Math.round(h)}:${dpr}`;
  if (woodCache.key === key) return woodCache.canvas;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  paintWood(g, w, h);
  woodCache = { key, canvas };
  return canvas;
}

function drawFrame(ctx, ox, oy, step) {
  const m = step * 0.66;
  const x = ox - m;
  const y = oy - m;
  const w = step * 8 + m * 2;
  const h = step * 9 + m * 2;
  ctx.save();
  ctx.strokeStyle = 'rgba(76, 43, 14, 0.55)';
  ctx.lineWidth = Math.max(2, step * 0.075);
  ctx.strokeRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(255, 241, 213, 0.38)';
  ctx.lineWidth = Math.max(1, step * 0.022);
  ctx.strokeRect(x + step * 0.1, y + step * 0.1, w - step * 0.2, h - step * 0.2);
  ctx.restore();
}

function drawGrid(ctx, X, Y, step) {
  const dark = 'rgba(84, 50, 18, 0.78)';
  const light = 'rgba(255, 245, 220, 0.42)';
  const lw = Math.max(1, step * 0.017);

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = lw;
  ctx.strokeStyle = dark;

  for (let y = 0; y < CHESS_H; y++) {
    ctx.beginPath();
    ctx.moveTo(X(0), Y(y));
    ctx.lineTo(X(8), Y(y));
    ctx.stroke();
  }
  for (let x = 0; x < CHESS_W; x++) {
    ctx.beginPath();
    ctx.moveTo(X(x), Y(0));
    ctx.lineTo(X(x), Y(4));
    ctx.moveTo(X(x), Y(5));
    ctx.lineTo(X(x), Y(9));
    ctx.stroke();
  }

  // 九宫斜线
  ctx.beginPath();
  ctx.moveTo(X(3), Y(0));
  ctx.lineTo(X(5), Y(2));
  ctx.moveTo(X(5), Y(0));
  ctx.lineTo(X(3), Y(2));
  ctx.moveTo(X(3), Y(7));
  ctx.lineTo(X(5), Y(9));
  ctx.moveTo(X(5), Y(7));
  ctx.lineTo(X(3), Y(9));
  ctx.stroke();

  // 刻痕高光
  ctx.strokeStyle = light;
  ctx.lineWidth = Math.max(0.8, lw * 0.8);
  ctx.beginPath();
  for (let y = 0; y < CHESS_H; y++) {
    ctx.moveTo(X(0), Y(y) + lw);
    ctx.lineTo(X(8), Y(y) + lw);
  }
  for (let x = 0; x < CHESS_W; x++) {
    ctx.moveTo(X(x) + lw, Y(0));
    ctx.lineTo(X(x) + lw, Y(4));
    ctx.moveTo(X(x) + lw, Y(5));
    ctx.lineTo(X(x) + lw, Y(9));
  }
  ctx.stroke();
  ctx.restore();

  // 楚河汉界
  ctx.save();
  ctx.fillStyle = 'rgba(92, 54, 18, 0.72)';
  ctx.font = `600 ${step * 0.44}px "KaiTi", "STKaiti", "Songti SC", "Noto Serif SC", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cy = Y(4.5);
  const left = X(2);
  const right = X(6);
  ['楚', '河'].forEach((ch, i) => ctx.fillText(ch, left + (i - 0.5) * step * 0.62, cy));
  ['漢', '界'].forEach((ch, i) => ctx.fillText(ch, right + (i - 0.5) * step * 0.62, cy));
  ctx.restore();
}

function drawTick(ctx, cx, cy, step) {
  const gap = step * 0.1;
  const len = step * 0.15;
  const lw = Math.max(1, step * 0.014);
  ctx.strokeStyle = 'rgba(84, 50, 18, 0.72)';
  ctx.lineWidth = lw;
  ctx.beginPath();
  // 左上
  ctx.moveTo(cx - gap - len, cy - gap);
  ctx.lineTo(cx - gap, cy - gap);
  ctx.lineTo(cx - gap, cy - gap - len);
  // 右上
  ctx.moveTo(cx + gap + len, cy - gap);
  ctx.lineTo(cx + gap, cy - gap);
  ctx.lineTo(cx + gap, cy - gap - len);
  // 左下
  ctx.moveTo(cx - gap - len, cy + gap);
  ctx.lineTo(cx - gap, cy + gap);
  ctx.lineTo(cx - gap, cy + gap + len);
  // 右下
  ctx.moveTo(cx + gap + len, cy + gap);
  ctx.lineTo(cx + gap, cy + gap);
  ctx.lineTo(cx + gap, cy + gap + len);
  ctx.stroke();
}

function drawMarkers(ctx, X, Y, step) {
  const points = [
    [1, 2], [7, 2], [1, 7], [7, 7],
    [0, 3], [2, 3], [4, 3], [6, 3], [8, 3],
    [0, 6], [2, 6], [4, 6], [6, 6], [8, 6]
  ];
  for (const [x, y] of points) drawTick(ctx, X(x), Y(y), step);
}

function drawChessPiece(ctx, cx, cy, r, piece, opts = {}) {
  const isRed = piece === piece.toUpperCase();
  const name = (isRed ? RED_NAMES : BLACK_NAMES)[piece.toUpperCase()] || piece;

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx + r * 0.08, cy + r * 0.16, r * 1.0, r * 0.94, 0, 0, TAU);
  ctx.fillStyle = 'rgba(56, 32, 10, 0.30)';
  ctx.filter = `blur(${Math.max(2, r * 0.16)}px)`;
  ctx.fill();
  ctx.restore();

  const base = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.36, r * 0.15, cx, cy, r);
  base.addColorStop(0, '#fffdf3');
  base.addColorStop(0.5, '#f6e7c9');
  base.addColorStop(0.86, '#e3cca2');
  base.addColorStop(1, '#c8aa7c');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fillStyle = base;
  ctx.fill();

  const highlight = ctx.createRadialGradient(
    cx - r * 0.38, cy - r * 0.44, r * 0.04,
    cx - r * 0.38, cy - r * 0.44, r * 0.85
  );
  highlight.addColorStop(0, 'rgba(255, 255, 255, 0.6)');
  highlight.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.88, 0, TAU);
  ctx.fillStyle = highlight;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.965, 0, TAU);
  ctx.lineWidth = Math.max(1.2, r * 0.06);
  ctx.strokeStyle = isRed ? 'rgba(147, 33, 24, 0.55)' : 'rgba(28, 31, 37, 0.6)';
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.8, 0, TAU);
  ctx.lineWidth = Math.max(0.8, r * 0.026);
  ctx.strokeStyle = isRed ? 'rgba(147, 33, 24, 0.32)' : 'rgba(28, 31, 37, 0.32)';
  ctx.stroke();

  ctx.save();
  ctx.font = `700 ${r * 1.14}px "KaiTi", "STKaiti", "Songti SC", "Noto Serif SC", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = isRed ? '#a8241a' : '#20242b';
  ctx.shadowColor = 'rgba(255, 253, 244, 0.7)';
  ctx.shadowBlur = r * 0.1;
  ctx.shadowOffsetY = r * 0.06;
  ctx.fillText(name, cx, cy + r * 0.04);
  ctx.restore();

  if (opts.selected) {
    ctx.save();
    ctx.shadowColor = 'rgba(246, 198, 107, 0.9)';
    ctx.shadowBlur = r * 0.75;
    ctx.strokeStyle = '#f4c96f';
    ctx.lineWidth = Math.max(2, r * 0.1);
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.06, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }
}

function drawCornerMark(ctx, cx, cy, r, stroke) {
  const gap = r * 1.02;
  const len = r * 0.3;
  ctx.save();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = Math.max(1.8, r * 0.075);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - gap - len, cy - gap);
  ctx.lineTo(cx - gap, cy - gap);
  ctx.lineTo(cx - gap, cy - gap - len);
  ctx.moveTo(cx + gap + len, cy - gap);
  ctx.lineTo(cx + gap, cy - gap);
  ctx.lineTo(cx + gap, cy - gap - len);
  ctx.moveTo(cx - gap - len, cy + gap);
  ctx.lineTo(cx - gap, cy + gap);
  ctx.lineTo(cx - gap, cy + gap + len);
  ctx.moveTo(cx + gap + len, cy + gap);
  ctx.lineTo(cx + gap, cy + gap);
  ctx.lineTo(cx + gap, cy + gap + len);
  ctx.stroke();
  ctx.restore();
}

function animateFrame() {
  if (!state.anim) return;
  drawBoard();
  if (state.anim) state.frame = requestAnimationFrame(animateFrame);
}

function drawChessBoard() {
  const room = state.room;
  if (!room) return;
  const { canvas, rect, w, h, step, ox, oy } = chessMetrics();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pw = Math.max(1, Math.round(rect.width * dpr));
  const ph = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(woodTexture(w, h, dpr), 0, 0, w, h);

  const X = (i) => ox + i * step;
  const Y = (i) => oy + i * step;
  const radius = step * 0.445;

  drawFrame(ctx, ox, oy, step);
  drawGrid(ctx, X, Y, step);
  drawMarkers(ctx, X, Y, step);

  // 悬停柔光：己方棋子 / 可落点
  if (state.hover && room.status === 'playing' && isMyTurn(room)) {
    const hx = X(state.hover.x);
    const hy = Y(state.hover.y);
    const halo = ctx.createRadialGradient(hx, hy, step * 0.1, hx, hy, step * 0.58);
    halo.addColorStop(0, 'rgba(255, 246, 220, 0.34)');
    halo.addColorStop(1, 'rgba(255, 246, 220, 0)');
    ctx.beginPath();
    ctx.arc(hx, hy, step * 0.58, 0, TAU);
    ctx.fillStyle = halo;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(hx, hy, radius * 1.12, 0, TAU);
    ctx.strokeStyle = 'rgba(255, 244, 214, 0.55)';
    ctx.lineWidth = Math.max(1, step * 0.02);
    ctx.stroke();
  }

  // 被将军的一方，帅/将外圈红光
  if (room.check && room.status === 'playing') {
    const side = room.turn === 1 ? 'r' : 'b';
    const general = GameRules.Chess.findGeneral(room.board, side);
    if (general) {
      const t = (Date.now() % 1400) / 1400;
      const alpha = 0.28 + 0.2 * Math.sin(t * TAU);
      const glow = ctx.createRadialGradient(
        X(general.x), Y(general.y), step * 0.2,
        X(general.x), Y(general.y), step * 1.05
      );
      glow.addColorStop(0, `rgba(214, 54, 38, ${alpha})`);
      glow.addColorStop(1, 'rgba(214, 54, 38, 0)');
      ctx.beginPath();
      ctx.arc(X(general.x), Y(general.y), step * 1.05, 0, TAU);
      ctx.fillStyle = glow;
      ctx.fill();
    }
    clearTimeout(state.pulseTimer);
    state.pulseTimer = setTimeout(() => {
      if (state.room && state.room.check && state.room.game === 'chess') drawBoard();
    }, 110);
  }

  const anim = state.anim;
  let progress = 1;
  if (anim) {
    progress = Math.min(1, (performance.now() - anim.start) / anim.dur);
  }

  const me = myPlayer(room);
  const last = room.moves[room.moves.length - 1];

  // 上一手的起点角标
  if (last && last.toX !== undefined) {
    drawCornerMark(ctx, X(last.fromX), Y(last.fromY), radius * 0.72, 'rgba(168, 118, 54, 0.5)');
  }

  for (let y = 0; y < CHESS_H; y++) {
    for (let x = 0; x < CHESS_W; x++) {
      const piece = room.board[y * CHESS_W + x];
      if (!piece) continue;
      if (anim && anim.to.x === x && anim.to.y === y) continue;
      const selected = state.selected && state.selected.x === x && state.selected.y === y;
      drawChessPiece(ctx, X(x), Y(y), radius, piece, { selected });
    }
  }

  // 落点标记：棋子外侧暖光 + 角标
  if (last && last.toX !== undefined) {
    const gx = X(last.toX);
    const gy = Y(last.toY);
    const halo = ctx.createRadialGradient(gx, gy, radius * 1.02, gx, gy, step * 0.74);
    halo.addColorStop(0, 'rgba(255, 203, 108, 0.6)');
    halo.addColorStop(0.5, 'rgba(255, 196, 92, 0.22)');
    halo.addColorStop(1, 'rgba(255, 196, 92, 0)');
    ctx.beginPath();
    ctx.arc(gx, gy, step * 0.74, 0, TAU);
    ctx.arc(gx, gy, radius * 1.02, 0, TAU, true);
    ctx.fillStyle = halo;
    ctx.fill();
    drawCornerMark(ctx, gx, gy, radius, 'rgba(255, 190, 96, 0.9)');
  }

  // 可走位置
  if (state.selected && state.legalMoves.length && room.status === 'playing' && isMyTurn(room)) {
    for (const move of state.legalMoves) {
      const cx = X(move.x);
      const cy = Y(move.y);
      const target = room.board[move.y * CHESS_W + move.x];
      if (target) {
        ctx.save();
        ctx.strokeStyle = 'rgba(198, 74, 52, 0.8)';
        ctx.lineWidth = Math.max(2, step * 0.045);
        ctx.beginPath();
        ctx.arc(cx, cy, radius * 1.04, 0, TAU);
        ctx.stroke();
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(3, step * 0.1), 0, TAU);
        ctx.fillStyle = 'rgba(66, 132, 82, 0.55)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(5, step * 0.16), 0, TAU);
        ctx.strokeStyle = 'rgba(66, 132, 82, 0.28)';
        ctx.lineWidth = Math.max(1, step * 0.016);
        ctx.stroke();
      }
    }
  }

  // 走子滑动动画
  if (anim) {
    const ease = 1 - Math.pow(1 - progress, 3);
    const fx = X(anim.from.x);
    const fy = Y(anim.from.y);
    const tx = X(anim.to.x);
    const ty = Y(anim.to.y);
    const cx = fx + (tx - fx) * ease;
    const cy = fy + (ty - fy) * ease - Math.sin(Math.PI * ease) * step * 0.12;
    drawChessPiece(ctx, cx, cy, radius * (1 + 0.05 * Math.sin(Math.PI * ease)), anim.piece, {});
    if (progress < 1) {
      state.frame = requestAnimationFrame(animateFrame);
    } else {
      state.anim = null;
    }
  }

  canvas.classList.toggle('readonly', !isMyTurn(room) || room.status !== 'playing');
  state.geo = { chess: true, ox, oy, step, w, h };
}

function lighten(hex, amt) {
  const c = hex.replace('#', '');
  const n = parseInt(c, 16);
  let r = (n >> 16) + Math.round(255 * amt);
  let g = ((n >> 8) & 255) + Math.round(255 * amt);
  let b = (n & 255) + Math.round(255 * amt);
  r = Math.min(255, r); g = Math.min(255, g); b = Math.min(255, b);
  return `rgb(${r},${g},${b})`;
}
function darken(hex, amt) {
  const c = hex.replace('#', '');
  const n = parseInt(c, 16);
  let r = Math.round((n >> 16) * (1 - amt));
  let g = Math.round(((n >> 8) & 255) * (1 - amt));
  let b = Math.round((n & 255) * (1 - amt));
  return `rgb(${r},${g},${b})`;
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function ensureChessAnim(room) {
  const last = room.moves[room.moves.length - 1];
  if (!last || last.toX === undefined) {
    state.anim = null;
    return;
  }
  const key = `${room.moves.length}:${last.fromX},${last.fromY}-${last.toX},${last.toY}`;
  if (state.animKey === key) return;
  state.animKey = key;
  state.anim = {
    piece: last.piece,
    from: { x: last.fromX, y: last.fromY },
    to: { x: last.toX, y: last.toY },
    start: performance.now(),
    dur: 190
  };
  cancelAnimationFrame(state.frame);
  state.frame = requestAnimationFrame(animateFrame);
}

function isOccupied(board, x, y) {
  return board[y * SIZE + x] !== 0;
}

function eventToCell(event) {
  if (!state.geo) return null;
  const canvas = $('#board');
  const rect = canvas.getBoundingClientRect();
  const geo = state.geo;

  if (geo.chess) {
    const px = event.clientX - rect.left - geo.ox;
    const py = event.clientY - rect.top - geo.oy;
    const x = Math.round(px / geo.step);
    const y = Math.round(py / geo.step);
    if (x < 0 || x >= CHESS_W || y < 0 || y >= CHESS_H) return null;
    if (Math.hypot(px - x * geo.step, py - y * geo.step) > geo.step * 0.62) return null;
    return { x, y };
  }

  if (geo.go) {
    const gx = event.clientX - rect.left - geo.ox - geo.pad;
    const gy = event.clientY - rect.top - geo.oy - geo.pad;
    const x = Math.round(gx / geo.step);
    const y = Math.round(gy / geo.step);
    if (x < 0 || x >= GO_SIZE || y < 0 || y >= GO_SIZE) return null;
    if (Math.hypot(gx - x * geo.step, gy - y * geo.step) > geo.step * 0.62) return null;
    return { x, y };
  }

  const { pad, step } = geo;
  const px = event.clientX - rect.left - pad;
  const py = event.clientY - rect.top - pad;
  const x = Math.round(px / step);
  const y = Math.round(py / step);
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return null;
  const dx = px - x * step;
  const dy = py - y * step;
  if (Math.hypot(dx, dy) > step * 0.62) return null;
  return { x, y };
}

function onBoardMove(event) {
  const room = state.room;
  if (!room) return;
  const cell = eventToCell(event);
  let next = null;
  if (cell && isMyTurn(room) && room.status === 'playing') {
    if (room.game === 'chess') {
      const myColor = myPlayer(room)?.color || 0;
      const asTarget = state.selected && state.legalMoves.some((m) => m.x === cell.x && m.y === cell.y);
      if (asTarget || isMyPiece(room, cell, myColor)) next = cell;
    } else if (room.game === 'go') {
      const grid = room.board.grid || [];
      if (!grid[cell.y * GO_SIZE + cell.x]) next = cell;
    } else if (!isOccupied(room.board, cell.x, cell.y)) {
      next = cell;
    }
  }
  if ((state.hover && next && state.hover.x === next.x && state.hover.y === next.y) || (!state.hover && !next)) {
    return;
  }
  state.hover = next;
  drawBoard();
}

function onBoardLeave() {
  if (!state.hover) return;
  state.hover = null;
  drawBoard();
}

function chessPieceOwner(piece) {
  if (!piece) return 0;
  return piece === piece.toUpperCase() ? 1 : 2;
}

function selectChessCell(cell) {
  const room = state.room;
  if (!room) return;
  state.selected = cell;
  state.legalMoves = GameRules.Chess.legalMoves(room.board, cell.x, cell.y);
  drawBoard();
}

function clearChessSelection() {
  state.selected = null;
  state.legalMoves = [];
}

async function sendChessMove(room, from, to) {
  try {
    const data = await api(`/rooms/${room.code}/move`, {
      method: 'POST',
      body: { playerId: state.playerId, from, to }
    });
    clearChessSelection();
    if (data.room) {
      state.room = data.room;
      renderRoom();
    }
  } catch (err) {
    toast(err.message);
  }
}

async function onBoardClick(event) {
  const room = state.room;
  if (!room || !room.board) return;
  if (!state.playerId) {
    toast('观战模式下不能走棋');
    return;
  }
  if (room.status !== 'playing' || !isMyTurn(room)) return;

  const cell = eventToCell(event);
  if (!cell) return;

  if (room.game === 'chess') {
    const myColor = myPlayer(room)?.color || 0;

    if (state.selected) {
      const target = state.legalMoves.find((m) => m.x === cell.x && m.y === cell.y);
      if (target) {
        const from = { x: state.selected.x, y: state.selected.y };
        await sendChessMove(room, from, { x: cell.x, y: cell.y });
        return;
      }
      if (isMyPiece(room, cell, myColor)) {
        selectChessCell(cell);
        return;
      }
      clearChessSelection();
      drawBoard();
      return;
    }
    if (isMyPiece(room, cell, myColor)) selectChessCell(cell);
    return;
  }

  if (room.game === 'go') {
    const grid = room.board.grid || [];
    if (grid[cell.y * GO_SIZE + cell.x]) return;
    state.hover = null;
    try {
      const data = await api(`/rooms/${room.code}/move`, {
        method: 'POST',
        body: { playerId: state.playerId, x: cell.x, y: cell.y }
      });
      if (data.room) {
        state.room = data.room;
        renderRoom();
      }
    } catch (err) {
      toast(err.message);
    }
    return;
  }

  if (isOccupied(room.board, cell.x, cell.y)) return;

  state.hover = null;
  try {
    const data = await api(`/rooms/${room.code}/move`, {
      method: 'POST',
      body: { playerId: state.playerId, x: cell.x, y: cell.y }
    });
    if (data.room) {
      state.room = data.room;
      renderRoom();
    }
  } catch (err) {
    toast(err.message);
  }
}

// 是否选中自己的棋子
function isMyPiece(room, cell, myColor) {
  const piece = room.board[cell.y * CHESS_W + cell.x];
  return Boolean(piece) && chessPieceOwner(piece) === myColor;
}

// ------------------------------------------------------------ 动作

async function resign() {
  if (!state.roomCode || !state.playerId) return;
  if (!window.confirm('确定认输本局？')) return;
  try {
    await api(`/rooms/${state.roomCode}/resign`, {
      method: 'POST',
      body: { playerId: state.playerId }
    });
  } catch (err) {
    toast(err.message);
  }
}

async function passMove() {
  const room = state.room;
  if (!room || !state.playerId) return;
  try {
    const data = await api(`/rooms/${room.code}/move`, {
      method: 'POST',
      body: { playerId: state.playerId, pass: true }
    });
    if (data.room) {
      state.room = data.room;
      renderRoom();
    }
  } catch (err) {
    toast(err.message);
  }
}

async function rematch() {
  if (!state.roomCode || !state.playerId) return;
  try {
    await api(`/rooms/${state.roomCode}/rematch`, {
      method: 'POST',
      body: { playerId: state.playerId }
    });
    toast('新的一局开始了');
  } catch (err) {
    toast(err.message);
  }
}

function confirmLeave() {
  const room = state.room;
  if (room && room.status === 'playing' && myPlayer(room)) {
    if (!window.confirm('离开进行中的对局将判负，确定离开？')) return;
  }
  leaveRoom();
}

async function copyInvite() {
  if (!state.roomCode) return;
  const link = `${location.origin}${location.pathname}#/room/${state.roomCode}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('邀请链接已复制');
  } catch {
    const input = document.createElement('input');
    input.value = link;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    input.remove();
    toast('邀请链接已复制');
  }
}

// ------------------------------------------------------------ 绑定

function applyGameUI() {
  const isChess = state.game === 'chess';
  const isGo = state.game === 'go';
  $('#chessNote').classList.toggle('hidden', !isChess);
  $('#firstHint').textContent = isChess ? '红方先行' : isGo ? '黑棋先行，双方连续停一手即点目' : '黑棋先行';
  $('#roomNameInput').placeholder = isChess ? '例如：楚河汉界' : isGo ? '例如：手谈一局' : '例如：周末棋局';

  const modeButtons = $$('#modeSwitch button');
  modeButtons.forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
  // 象棋/围棋 AI 引擎固定本地，LLM 不支持
  $('#engineField').classList.toggle('hidden', isChess || isGo || state.mode !== 'ai');
}

function bind() {
  const nameInput = $('#nameInput');
  if (nameInput) {
    nameInput.value = state.name;
    nameInput.addEventListener('input', (event) => {
      state.name = event.target.value.trim();
      localStorage.setItem('gomoku:name', state.name);
    });
  }

  $('#createForm').addEventListener('submit', createRoom);

  $('#gameSwitch').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-game]');
    if (!btn) return;
    state.game = btn.dataset.game;
    $$('#gameSwitch button').forEach((b) => b.classList.toggle('active', b === btn));
    applyGameUI();
  });

  $('#modeSwitch').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-mode]');
    if (!btn || btn.disabled) return;
    state.mode = btn.dataset.mode;
    $$('#modeSwitch button').forEach((b) => b.classList.toggle('active', b === btn));
    $('#engineField').classList.toggle('hidden', state.mode !== 'ai' || state.game === 'chess' || state.game === 'go');
  });

  $('#engineSwitch').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-engine]');
    if (!btn) return;
    state.engine = btn.dataset.engine;
    $$('#engineSwitch button').forEach((b) => b.classList.toggle('active', b === btn));
  });

  $('#joinForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const code = $('#joinCodeInput').value.trim().toUpperCase();
    if (!code) return;
    joinRoom(code);
    $('#joinCodeInput').value = '';
  });

  $('#roomList').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-join]');
    if (!btn) return;
    joinRoom(btn.dataset.join);
  });

  $('#refreshBtn').addEventListener('click', loadRooms);

  $('#backBtn').addEventListener('click', confirmLeave);

  $('#copyBtn').addEventListener('click', copyInvite);
  $('#resignBtn').addEventListener('click', resign);
  $('#passBtn').addEventListener('click', passMove);
  $('#rematchBtn').addEventListener('click', rematch);
  $('#leaveBtn').addEventListener('click', confirmLeave);
  $('#rejoinLink').addEventListener('click', rejoinAsPlayer);

  $('#chatToggle').addEventListener('click', toggleChat);
  $('#chatForm').addEventListener('submit', sendChat);

  $('#settingsBtn').addEventListener('click', openSettings);
  $('#closeSettings').addEventListener('click', closeSettings);
  $('#settingsModal').addEventListener('click', (event) => {
    if (event.target.dataset.close) closeSettings();
  });
  $('#saveSettingsBtn').addEventListener('click', saveSettings);
  $('#testKeyBtn').addEventListener('click', testKey);
  $('#clearKeyBtn').addEventListener('click', clearKey);
  $('#modelSelect').addEventListener('change', (event) => {
    $('#modelInput').value = event.target.value;
  });
  $('#providerSelect').addEventListener('change', async (event) => {
    const provider = event.target.value;
    try {
      const data = await api('/config', { method: 'POST', body: { provider } });
      state.config = { ...(state.config || {}), ...data };
      applyProviderUI();
      await loadModels();
      const model = (state.config && state.config.model) || '';
      if (model) $('#modelInput').value = model;
      renderKeyState();
      updateEngineAvailability();
    } catch (err) {
      toast(err.message);
    }
  });

  const canvas = $('#board');
  canvas.addEventListener('mousemove', onBoardMove);
  canvas.addEventListener('mouseleave', onBoardLeave);
  canvas.addEventListener('click', onBoardClick);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSettings();
  });

  window.addEventListener('hashchange', route);
  window.addEventListener('popstate', route);

  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(() => {
      if (state.room && !$('#roomView').classList.contains('hidden')) drawBoard();
    });
    observer.observe($('#board'));
  } else {
    window.addEventListener('resize', drawBoard);
  }
}

function route() {
  if (!state.user) { showAuth(); return; }
  const match = location.hash.match(/^#\/room\/([A-Za-z0-9]+)/);
  if (match) {
    const code = match[1].toUpperCase();
    if (state.roomCode === code && state.sse) return;
    const stored = localStorage.getItem(`gomoku:pid:${code}`) || '';
    joinRoom(code, { silent: true }).then(() => {
      if (!state.roomCode) {
        // 加入失败，尝试以观战身份进入
        enterRoom({ code, status: 'playing' }, stored);
      }
    });
  } else {
    if (state.sse) {
      leaveRoom({ silent: true });
    }
    goLobby();
  }
}

// ============================================================ 认证
function showAuth() {
  $('#authView').classList.remove('hidden');
  $('#userChip').classList.add('hidden');
  if (state.sse) { try { state.sse.close(); } catch {} state.sse = null; }
  // 每次回到登录页都重置为「登录」状态
  $$('.authTabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'login'));
  $('#authSubmit').textContent = '登录';
  $('#authEmailField').classList.add('hidden');
  $('#authPass2Field').classList.add('hidden');
  $('#forgotPassBtn').classList.remove('hidden');
  $('#authHint').textContent = '';
  $('#authEmail').value = '';
  $('#authPass').value = '';
  $('#authPass2').value = '';
}
function hideAuth() {
  $('#authView').classList.add('hidden');
}

function setAuthUser(user) {
  state.user = user;
  state.name = user.username;
  localStorage.setItem('gomoku:name', state.name);
  $('#userNameLabel').textContent = user.username + (user.role === 'admin' ? ' 👑' : '');
  $('#userIdLabel').textContent = 'ID: ' + user.id.slice(0, 8);
  const isImgAvatar = user.avatar && (user.avatar.startsWith('http') || user.avatar.startsWith('data:'));
  $('#avatarEmoji').textContent = isImgAvatar ? '' : (user.avatar || '🐱');
  if (isImgAvatar) {
    $('#avatarEmoji').style.backgroundImage = `url(${user.avatar})`;
  } else {
    $('#avatarEmoji').style.backgroundImage = '';
  }
  $('#userChip').classList.remove('hidden');
  $('#adminBtn').classList.toggle('hidden', user.role !== 'admin');
  hideAuth();
  connectUserEvents();
  loadFriends();
}

async function bootAuth() {
  if (!state.token) { showAuth(); return; }
  try {
    const data = await api('/auth/me');
    setAuthUser(data.user);
  } catch {
    state.token = '';
    localStorage.removeItem('gomoku:token');
    showAuth();
  }
}

function logout(notify = true) {
  const token = state.token;
  state.token = '';
  state.user = null;
  localStorage.removeItem('gomoku:token');
  if (state.userSse) { try { state.userSse.close(); } catch {} state.userSse = null; }
  if (token) api('/auth/logout', { method: 'POST' }).catch(() => {});
  if (notify) toast('已退出登录');
  showAuth();
}

async function submitAuth(event) {
  event.preventDefault();
  const tab = document.querySelector('.authTabs button.active')?.dataset.tab || 'login';
  const username = $('#authUser').value.trim();
  const password = $('#authPass').value;
  const hint = $('#authHint');
  try {
    if (tab === 'register') {
      const p2 = $('#authPass2').value;
      if (password !== p2) { hint.textContent = '两次密码不一致'; return; }
      const email = $('#authEmail').value.trim();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { hint.textContent = '邮箱格式不正确'; return; }
      const data = await api('/auth/register', { method: 'POST', body: { username, password, email } });
      state.token = data.token;
      localStorage.setItem('gomoku:token', state.token);
      setAuthUser(data.user);
      route();
    } else {
      const data = await api('/auth/login', { method: 'POST', body: { username, password } });
      state.token = data.token;
      localStorage.setItem('gomoku:token', state.token);
      setAuthUser(data.user);
      route();
    }
  } catch (e) {
    hint.textContent = e.message || '操作失败';
  }
}

// ============================================================ 忘记密码
function openForgot() {
  $('#forgotEmail').value = '';
  $('#forgotCode').value = '';
  $('#forgotNewPass').value = '';
  $('#forgotNewPass2').value = '';
  $('#forgotHint').textContent = '';
  $('#forgotStep1').classList.remove('hidden');
  $('#forgotStep2').classList.add('hidden');
  $('#forgotModal').classList.remove('hidden');
}

let forgotEmail = '';
let forgotResendTimer = null;
function startResendCountdown() {
  const btn = $('#resendCodeBtn');
  let s = 60;
  btn.disabled = true;
  btn.textContent = `${s}s 后重发`;
  clearInterval(forgotResendTimer);
  forgotResendTimer = setInterval(() => {
    s -= 1;
    if (s <= 0) {
      clearInterval(forgotResendTimer);
      btn.disabled = false;
      btn.textContent = '重新发送';
    } else {
      btn.textContent = `${s}s 后重发`;
    }
  }, 1000);
}

async function sendResetCode() {
  const email = $('#forgotEmail').value.trim();
  const hint = $('#forgotHint');
  if (!email) { hint.textContent = '请输入邮箱'; return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { hint.textContent = '邮箱格式不正确'; return; }
  try {
    const data = await api('/auth/forgot-password', { method: 'POST', body: { email } });
    forgotEmail = email;
    $('#forgotStep1').classList.add('hidden');
    $('#forgotStep2').classList.remove('hidden');
    startResendCountdown();
    if (data.dev) {
      hint.textContent = '开发模式：验证码已打印到服务端控制台';
    } else {
      hint.textContent = '验证码已发送至邮箱，10 分钟内有效';
    }
  } catch (e) {
    hint.textContent = e.message || '发送失败';
  }
}

async function resendCode() {
  if (!forgotEmail) return;
  const hint = $('#forgotHint');
  try {
    const data = await api('/auth/forgot-password', { method: 'POST', body: { email: forgotEmail } });
    startResendCountdown();
    if (data.dev) {
      hint.textContent = '开发模式：验证码已打印到服务端控制台';
    } else {
      hint.textContent = '验证码已重新发送';
    }
  } catch (e) {
    hint.textContent = e.message || '发送失败';
  }
}

async function doResetPassword() {
  const code = $('#forgotCode').value.trim();
  const p1 = $('#forgotNewPass').value;
  const p2 = $('#forgotNewPass2').value;
  const hint = $('#forgotHint');
  if (!code) { hint.textContent = '请输入验证码'; return; }
  if (p1.length < 4 || p1.length > 64) { hint.textContent = '密码长度需 4-64 位'; return; }
  if (p1 !== p2) { hint.textContent = '两次密码不一致'; return; }
  try {
    await api('/auth/reset-password', { method: 'POST', body: { email: forgotEmail, code, newPassword: p1 } });
    toast('密码已重置，请用新密码登录');
    $('#forgotModal').classList.add('hidden');
    clearInterval(forgotResendTimer);
    // 切回登录 tab
    $$('.authTabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'login'));
    $('#authSubmit').textContent = '登录';
    $('#authPass2Field').classList.add('hidden');
    $('#authEmailField').classList.add('hidden');
    $('#forgotPassBtn').classList.remove('hidden');
  } catch (e) {
    hint.textContent = e.message || '重置失败';
  }
}
function connectUserEvents() {
  if (state.userSse) { try { state.userSse.close(); } catch {} }
  const es = new EventSource('/api/events');
  state.userSse = es;
  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      handleUserEvent(data);
    } catch {}
  };
  es.onerror = () => { /* 自动重连由浏览器处理 */ };
}

function handleUserEvent(data) {
  if (data.type === 'friend_request') {
    toast(`${data.from.username} 请求添加你为好友`);
    loadFriends();
  } else if (data.type === 'friend_accept') {
    toast(`${data.from.username} 接受了你的好友请求`);
    loadFriends();
  } else if (data.type === 'dm') {
    state.dmUnread[data.from.id] = (state.dmUnread[data.from.id] || 0) + 1;
    if (state.dmOpen && state.dmOpen.id === data.from.id) {
      loadDm(data.from.id);
    } else {
      const msgType = data.msgType || 'text';
      let preview = data.text || '';
      if (msgType === 'image') preview = '[图片]';
      else if (msgType === 'video') preview = '[视频]';
      else if (msgType === 'voice') preview = '[语音]';
      toast(`${data.from.username}: ${preview}`);
    }
    updateFriendBadge();
    renderFriends(); // 刷新好友列表红点
  } else if (data.type === 'challenge') {
    const gameLabel = data.game === 'chess' ? '象棋' : data.game === 'go' ? '围棋' : '五子棋';
    const accept = confirm(`${data.from.username} 邀请你切磋${gameLabel}，是否接受？`);
    if (accept) {
      location.hash = `#/room/${data.roomCode}`;
    }
  } else if (data.type === 'banned') {
    toast(`你的账号已被封禁${data.reason ? '：' + data.reason : ''}`);
    logout(false);
  }
}

// ============================================================ 好友
async function loadFriends() {
  if (!state.user) return;
  try {
    const data = await api('/friends');
    state.friends = data.friends || [];
    state.incoming = data.incoming || [];
    state.outgoing = data.outgoing || [];
    renderFriends();
    updateFriendBadge();
  } catch {}
}

function updateFriendBadge() {
  const n = (state.incoming?.length || 0) + Object.values(state.dmUnread || {}).reduce((a, b) => a + b, 0);
  const badge = $('#friendBadge');
  badge.textContent = n;
  badge.classList.toggle('hidden', n === 0);
}

function avatarHtml(avatar) {
  if (avatar && (avatar.startsWith('http') || avatar.startsWith('data:'))) return `<img src="${escapeHtml(avatar)}" alt="">`;
  return `<span>${escapeHtml(avatar || '🐱')}</span>`;
}

function renderFriends() {
  $('#friendCount').textContent = state.friends.length;
  $('#incomingCount').textContent = state.incoming.length;
  $('#friendList').innerHTML = state.friends.map((f) => {
    const unread = state.dmUnread[f.id] || 0;
    return `
    <li class="friendItem">
      <div class="friendAvatar">
        ${avatarHtml(f.avatar)}
        ${unread > 0 ? `<span class="friendDot">${unread > 99 ? '99+' : unread}</span>` : ''}
      </div>
      <div class="friendMeta">
        <b>${escapeHtml(f.username)}</b>
        <small class="muted">${f.online ? '在线' : '离线'} · ${f.id.slice(0, 8)}</small>
      </div>
      <div class="friendActions">
        <button class="ghostBtn small" data-dm="${f.id}" data-name="${escapeHtml(f.username)}" data-avatar="${escapeHtml(f.avatar || '')}">私聊</button>
        <button class="ghostBtn small" data-challenge="${f.id}" data-name="${escapeHtml(f.username)}">切磋</button>
        <button class="ghostBtn small danger" data-unfriend="${f.id}">删除</button>
      </div>
    </li>`;
  }).join('') || '<li class="muted">还没有好友，搜索用户名添加</li>';

  $('#incomingList').innerHTML = state.incoming.map((r) => `
    <li class="friendItem">
      <div class="friendAvatar">${avatarHtml(r.avatar)}</div>
      <div class="friendMeta">
        <b>${escapeHtml(r.username)}</b>
        <small class="muted">请求加你 · ${r.id.slice(0, 8)}</small>
      </div>
      <div class="friendActions">
        <button class="primaryBtn small" data-accept="${r.id}">接受</button>
        <button class="ghostBtn small" data-reject="${r.id}">拒绝</button>
      </div>
    </li>
  `).join('') + state.outgoing.map((r) => `
    <li class="friendItem">
      <div class="friendAvatar">${avatarHtml(r.avatar)}</div>
      <div class="friendMeta">
        <b>${escapeHtml(r.username)}</b>
        <small class="muted">已发送请求 · ${r.id.slice(0, 8)}</small>
      </div>
      <div class="friendActions">
        <button class="ghostBtn small" data-cancel="${r.id}">取消</button>
      </div>
    </li>
  `).join('') || '<li class="muted">暂无请求</li>';
}

let searchTimer = null;
function onFriendSearchInput() {
  clearTimeout(searchTimer);
  const q = $('#friendSearchInput').value.trim();
  if (!q) { renderFriends(); return; }
  searchTimer = setTimeout(async () => {
    try {
      const data = await api(`/users/search?q=${encodeURIComponent(q)}`);
      $('#friendList').innerHTML = data.users.map((u) => `
        <li class="friendItem">
          <div class="friendAvatar">${avatarHtml(u.avatar)}</div>
          <div class="friendMeta">
            <b>${escapeHtml(u.username)}</b>
            <small class="muted">${u.id.slice(0, 8)}</small>
          </div>
          <div class="friendActions">
            ${u.isFriend ? '<span class="muted">已是好友</span>'
              : u.outgoing ? '<span class="muted">已发送</span>'
              : u.incoming ? `<button class="primaryBtn small" data-accept="${u.id}">接受</button>`
              : `<button class="primaryBtn small" data-request="${u.id}">加好友</button>`}
          </div>
        </li>
      `).join('') || '<li class="muted">未找到用户</li>';
    } catch (e) { toast(e.message); }
  }, 300);
}

async function friendAction(action, userId, extra = {}) {
  try {
    if (action === 'request') await api('/friends/request', { method: 'POST', body: { userId } });
    else if (action === 'accept') await api('/friends/accept', { method: 'POST', body: { userId } });
    else if (action === 'reject') await api('/friends/reject', { method: 'POST', body: { userId } });
    else if (action === 'cancel') await api('/friends/cancel', { method: 'POST', body: { userId } });
    else if (action === 'unfriend') await api(`/friends/${userId}`, { method: 'DELETE' });
    // 若处于搜索态，刷新搜索结果；否则刷新好友列表
    const q = $('#friendSearchInput')?.value.trim();
    if (q) onFriendSearchInput();
    else loadFriends();
  } catch (e) { toast(e.message); }
}

// ============================================================ 私聊
async function openDm(friend) {
  state.dmOpen = friend;
  state.dmUnread[friend.id] = 0;
  updateFriendBadge();
  $('#dmTitle').textContent = `与 ${friend.username} 私聊`;
  $('#dmModal').classList.remove('hidden');
  await loadDm(friend.id);
  setTimeout(() => $('#dmInput').focus(), 50);
}

async function loadDm(userId) {
  try {
    const data = await api(`/dm/${userId}`);
    state.dmMessages = data.messages || [];
    renderDm();
  } catch {}
}

function renderDm() {
  const me = state.user?.id;
  $('#dmList').innerHTML = state.dmMessages.map((m) => {
    const mine = m.from === me;
    const type = m.type || 'text';
    let body = '';
    if (type === 'text') {
      body = `<span>${escapeHtml(m.text)}</span>`;
    } else if (type === 'image') {
      body = `<img class="dmMedia" src="${escapeHtml(m.data)}" alt="图片" onclick="window.open(this.src)">`;
    } else if (type === 'video') {
      body = `<video class="dmMedia" src="${escapeHtml(m.data)}" controls preload="metadata"></video>`;
    } else if (type === 'voice') {
      const dur = m.duration || 1;
      body = `<button class="voiceBubble" onclick="this.nextElementSibling.play()">
        <span class="voiceIcon">🔊</span><span class="voiceDur">${dur}"</span>
      </button><audio src="${escapeHtml(m.data)}" preload="none"></audio>`;
    }
    return `<li class="dmMsg ${mine ? 'mine' : 'theirs'}">${body}<small class="muted">${new Date(m.at).toLocaleTimeString().slice(0, 5)}</small></li>`;
  }).join('') || '<li class="muted">还没有消息</li>';
  const list = $('#dmList');
  list.scrollTop = list.scrollHeight;
}

async function sendDm(event) {
  event.preventDefault();
  const input = $('#dmInput');
  const text = input.value.trim();
  if (!text || !state.dmOpen) return;
  try {
    await api(`/dm/${state.dmOpen.id}`, { method: 'POST', body: { type: 'text', text } });
    input.value = '';
    loadDm(state.dmOpen.id);
  } catch (e) { toast(e.message); }
}

// 发送媒体消息
async function sendMedia(type, data, duration) {
  if (!state.dmOpen) return;
  try {
    const body = { type, data };
    if (type === 'voice') body.duration = duration;
    await api(`/dm/${state.dmOpen.id}`, { method: 'POST', body });
    loadDm(state.dmOpen.id);
  } catch (e) { toast(e.message); }
}

// 图片：压缩后转 data URL
function handleDmImage(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('请选择图片'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const max = 1280;
      let { width, height } = img;
      if (width > max || height > max) {
        if (width > height) { height = Math.round(height * max / width); width = max; }
        else { width = Math.round(width * max / height); height = max; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      sendMedia('image', dataUrl);
    };
    img.onerror = () => toast('图片读取失败');
    img.src = reader.result;
  };
  reader.onerror = () => toast('图片读取失败');
  reader.readAsDataURL(file);
}

// 视频：直接转 data URL
function handleDmVideo(file) {
  if (!file) return;
  if (!file.type.startsWith('video/')) { toast('请选择视频'); return; }
  if (file.size > 8 * 1024 * 1024) { toast('视频过大（>8MB）'); return; }
  const reader = new FileReader();
  reader.onload = () => sendMedia('video', reader.result);
  reader.onerror = () => toast('视频读取失败');
  reader.readAsDataURL(file);
}

// 语音录制
let mediaRecorder = null;
let voiceChunks = [];
let voiceStartTime = 0;
let voiceTimer = null;
let recordedVoiceBlob = null;

async function startVoiceRecord() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    voiceChunks = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) voiceChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      recordedVoiceBlob = new Blob(voiceChunks, { type: 'audio/webm' });
    };
    mediaRecorder.start();
    voiceStartTime = Date.now();
    recordedVoiceBlob = null;
    $('#voiceBar').classList.remove('hidden');
    $('#dmForm').classList.add('hidden');
    voiceTimer = setInterval(() => {
      const s = Math.floor((Date.now() - voiceStartTime) / 1000);
      $('#voiceTimer').textContent = s + '"';
      if (s >= 60) stopVoiceRecord(true);
    }, 500);
  } catch (e) {
    toast('无法访问麦克风：' + e.message);
  }
}

function stopVoiceRecord(autoSend) {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
  mediaRecorder.stop();
  clearInterval(voiceTimer);
  const duration = Math.max(1, Math.floor((Date.now() - voiceStartTime) / 1000));
  if (autoSend) {
    // 等 onstop 处理完 blob
    setTimeout(() => {
      if (recordedVoiceBlob && duration >= 1) {
        const reader = new FileReader();
        reader.onload = () => {
          sendMedia('voice', reader.result, duration);
          $('#voiceBar').classList.add('hidden');
          $('#dmForm').classList.remove('hidden');
        };
        reader.readAsDataURL(recordedVoiceBlob);
      } else {
        $('#voiceBar').classList.add('hidden');
        $('#dmForm').classList.remove('hidden');
      }
    }, 100);
  }
}

function cancelVoiceRecord() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.onstop = () => {};
    mediaRecorder.stop();
  }
  clearInterval(voiceTimer);
  recordedVoiceBlob = null;
  $('#voiceBar').classList.add('hidden');
  $('#dmForm').classList.remove('hidden');
}

// 加号菜单
function togglePlusMenu() {
  $('#plusMenu').classList.toggle('hidden');
}

// ============================================================ 切磋
async function challengeFriend(userId, username) {
  const choice = prompt(`邀请 ${username} 对弈，选择棋种：\n1 = 中国象棋\n2 = 五子棋\n3 = 围棋`, '1');
  if (choice === null) return;
  const key = choice.trim();
  const game = key === '1' ? 'chess' : key === '3' ? 'go' : 'gomoku';
  try {
    const data = await api('/friends/challenge', { method: 'POST', body: { userId, game } });
    toast(`已向 ${username} 发送切磋邀请`);
    location.hash = `#/room/${data.room.code}`;
  } catch (e) { toast(e.message); }
}

// ============================================================ 头像编辑
const AVATAR_PRESETS = ['🐱','🐶','🦊','🐼','🐨','🦁','🐯','🐰','🐸','🐵','🐮','🐷','🦄','🐲','🐙','🦉','🐧','🦋','🐝','🌸','🍀','⭐','🔥','🎯'];
function openAvatar() {
  const grid = $('#avatarGrid');
  const current = state.user?.avatar || '';
  $('#avatarUrlInput').value = current.startsWith('http') || current.startsWith('data:') ? current : '';
  $('#avatarFileInput').value = '';
  $('#avatarPreview').classList.add('hidden');
  $('#avatarPreview').innerHTML = '';
  selectedAvatar = null;
  grid.innerHTML = AVATAR_PRESETS.map((e) => `
    <button type="button" class="avatarTile ${current === e ? 'selected' : ''}" data-avatar="${e}">${e}</button>
  `).join('');
  $('#avatarModal').classList.remove('hidden');
}

let selectedAvatar = null;
let uploadedAvatarData = null; // base64 data URL
async function saveAvatar() {
  const urlVal = $('#avatarUrlInput').value.trim();
  const avatar = uploadedAvatarData || urlVal || selectedAvatar || state.user?.avatar;
  if (!avatar) return;
  try {
    const data = await api('/auth/avatar', { method: 'PUT', body: { avatar } });
    setAuthUser(data.user);
    $('#avatarModal').classList.add('hidden');
    uploadedAvatarData = null;
    toast('头像已更新');
  } catch (e) { toast(e.message); }
}

// 读取本地图片并压缩为 data URL（限制尺寸和大小）
function handleAvatarFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('请选择图片文件'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const max = 256;
      let { width, height } = img;
      if (width > height) { if (width > max) { height = Math.round(height * max / width); width = max; } }
      else { if (height > max) { width = Math.round(width * max / height); height = max; } }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      uploadedAvatarData = dataUrl;
      selectedAvatar = null;
      $('#avatarUrlInput').value = '';
      $$('#avatarGrid .avatarTile').forEach((x) => x.classList.remove('selected'));
      const preview = $('#avatarPreview');
      preview.innerHTML = `<img src="${dataUrl}" alt="预览">`;
      preview.classList.remove('hidden');
    };
    img.onerror = () => toast('图片读取失败');
    img.src = reader.result;
  };
  reader.onerror = () => toast('图片读取失败');
  reader.readAsDataURL(file);
}

// ============================================================ 管理员面板
async function openAdmin() {
  try {
    const data = await api('/admin/users');
    renderAdmin(data.users);
    $('#adminModal').classList.remove('hidden');
  } catch (e) { toast(e.message); }
}

function renderAdmin(users) {
  $('#adminTable').innerHTML = `
    <table>
      <thead><tr><th>用户</th><th>ID</th><th>角色</th><th>状态</th><th>好友</th><th>操作</th></tr></thead>
      <tbody>
        ${users.map((u) => `
          <tr>
            <td><div class="friendAvatar">${avatarHtml(u.avatar)}</div> ${escapeHtml(u.username)}</td>
            <td class="muted">${u.id.slice(0, 10)}</td>
            <td>${u.role === 'admin' ? '<b>管理员</b>' : '普通'}</td>
            <td>${u.banned ? `<span class="tag banned">封禁</span>` : (u.online ? '<span class="tag online">在线</span>' : '<span class="muted">离线</span>')}</td>
            <td>${u.friendCount}</td>
            <td class="adminOps">
              ${u.banned
                ? `<button class="ghostBtn small" data-unban="${u.id}">解封</button>`
                : `<button class="ghostBtn small danger" data-ban="${u.id}">封禁</button>`}
              ${u.role === 'admin'
                ? `<button class="ghostBtn small" data-role="${u.id}" data-r="user">降为普通</button>`
                : `<button class="ghostBtn small" data-role="${u.id}" data-r="admin">设为管理员</button>`}
              <button class="ghostBtn small" data-impersonate="${u.id}">操控</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

async function adminAction(action, userId, extra = {}) {
  try {
    if (action === 'ban') {
      const reason = prompt('封禁原因（可选）：') || '';
      await api(`/admin/users/${userId}/ban`, { method: 'POST', body: { reason } });
    } else if (action === 'unban') {
      await api(`/admin/users/${userId}/unban`, { method: 'POST' });
    } else if (action === 'role') {
      await api(`/admin/users/${userId}/role`, { method: 'POST', body: { role: extra.role } });
    } else if (action === 'impersonate') {
      const data = await api(`/admin/users/${userId}/impersonate`, { method: 'POST' });
      state.token = data.token;
      localStorage.setItem('gomoku:token', state.token);
      setAuthUser(data.user);
      $('#adminModal').classList.add('hidden');
      toast(`已切换为 ${data.user.username}`);
      return;
    }
    openAdmin();
  } catch (e) { toast(e.message); }
}

// ============================================================ 绑定
function bindExtra() {
  // 认证
  $$('.authTabs button').forEach((b) => b.addEventListener('click', () => {
    $$('.authTabs button').forEach((x) => x.classList.toggle('active', x === b));
    const tab = b.dataset.tab;
    $('#authSubmit').textContent = tab === 'login' ? '登录' : '注册';
    $('#authPass2Field').classList.toggle('hidden', tab !== 'register');
    $('#authEmailField').classList.toggle('hidden', tab !== 'register');
    $('#forgotPassBtn').classList.toggle('hidden', tab !== 'login');
    $('#authHint').textContent = tab === 'login' ? '' : '注册后即可联机对弈';
  }));
  $('#authForm').addEventListener('submit', submitAuth);
  $('#forgotPassBtn').addEventListener('click', openForgot);

  // 顶部
  $('#logoutBtn').addEventListener('click', () => logout(true));
  $('#avatarBtn').addEventListener('click', openAvatar);
  $('#friendsBtn').addEventListener('click', () => { loadFriends(); $('#friendsModal').classList.remove('hidden'); });
  $('#adminBtn').addEventListener('click', openAdmin);
  $('#leaderboardBtn').addEventListener('click', openLeaderboard);
  $('#closeLeaderboard').addEventListener('click', () => $('#leaderboardModal').classList.add('hidden'));
  $('#leaderboardModal').addEventListener('click', (e) => { if (e.target.dataset.close) $('#leaderboardModal').classList.add('hidden'); });
  $('#lbGameTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-game]');
    if (!btn) return;
    lbState.game = btn.dataset.game;
    $$('#lbGameTabs button').forEach((b) => b.classList.toggle('active', b === btn));
    loadLeaderboard();
  });
  $('#lbPeriodTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-period]');
    if (!btn) return;
    lbState.period = btn.dataset.period;
    $$('#lbPeriodTabs button').forEach((b) => b.classList.toggle('active', b === btn));
    loadLeaderboard();
  });
  $('#privLobby').addEventListener('change', savePrivacy);
  $('#privLeaderboard').addEventListener('change', savePrivacy);

  // 好友
  $('#closeFriends').addEventListener('click', () => $('#friendsModal').classList.add('hidden'));
  $('#friendsModal').addEventListener('click', (e) => { if (e.target.dataset.close) $('#friendsModal').classList.add('hidden'); });
  $('#friendSearchInput').addEventListener('input', onFriendSearchInput);
  $('#friendList').addEventListener('click', (e) => {
    const t = e.target;
    if (t.dataset.request) friendAction('request', t.dataset.request);
    else if (t.dataset.accept) friendAction('accept', t.dataset.accept);
    else if (t.dataset.reject) friendAction('reject', t.dataset.reject);
    else if (t.dataset.unfriend) friendAction('unfriend', t.dataset.unfriend);
    else if (t.dataset.dm) openDm({ id: t.dataset.dm, username: t.dataset.name, avatar: t.dataset.avatar });
    else if (t.dataset.challenge) challengeFriend(t.dataset.challenge, t.dataset.name);
  });
  $('#incomingList').addEventListener('click', (e) => {
    const t = e.target;
    if (t.dataset.accept) friendAction('accept', t.dataset.accept);
    else if (t.dataset.reject) friendAction('reject', t.dataset.reject);
    else if (t.dataset.cancel) friendAction('cancel', t.dataset.cancel);
  });

  // 头像
  $('#closeAvatar').addEventListener('click', () => $('#avatarModal').classList.add('hidden'));
  $('#avatarModal').addEventListener('click', (e) => { if (e.target.dataset.close) $('#avatarModal').classList.add('hidden'); });
  $('#avatarGrid').addEventListener('click', (e) => {
    const t = e.target.closest('.avatarTile');
    if (!t) return;
    selectedAvatar = t.dataset.avatar;
    uploadedAvatarData = null;
    $$('#avatarGrid .avatarTile').forEach((x) => x.classList.toggle('selected', x === t));
    $('#avatarUrlInput').value = '';
    $('#avatarFileInput').value = '';
    $('#avatarPreview').classList.add('hidden');
    $('#avatarPreview').innerHTML = '';
  });
  $('#avatarUrlInput').addEventListener('input', () => {
    if ($('#avatarUrlInput').value) {
      selectedAvatar = null;
      uploadedAvatarData = null;
      $$('#avatarGrid .avatarTile').forEach((x) => x.classList.remove('selected'));
      $('#avatarPreview').classList.add('hidden');
    }
  });
  $('#avatarFileInput').addEventListener('change', (e) => handleAvatarFile(e.target.files[0]));
  $('#saveAvatarBtn').addEventListener('click', saveAvatar);

  // 私聊
  $('#closeDm').addEventListener('click', () => { $('#dmModal').classList.add('hidden'); state.dmOpen = null; cancelVoiceRecord(); });
  $('#dmModal').addEventListener('click', (e) => { if (e.target.dataset.close) { $('#dmModal').classList.add('hidden'); state.dmOpen = null; cancelVoiceRecord(); } });
  $('#dmForm').addEventListener('submit', sendDm);

  // 加号菜单
  $('#dmPlusBtn').addEventListener('click', (e) => { e.stopPropagation(); togglePlusMenu(); });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#plusMenu') && !e.target.closest('#dmPlusBtn')) {
      $('#plusMenu').classList.add('hidden');
    }
  });
  $('#plusMenu').addEventListener('click', (e) => {
    const t = e.target.closest('[data-plus]');
    if (!t) return;
    $('#plusMenu').classList.add('hidden');
    const kind = t.dataset.plus;
    if (kind === 'image') $('#dmImageInput').click();
    else if (kind === 'video') $('#dmVideoInput').click();
    else if (kind === 'voice') startVoiceRecord();
  });
  $('#dmImageInput').addEventListener('change', (e) => handleDmImage(e.target.files[0]));
  $('#dmVideoInput').addEventListener('change', (e) => handleDmVideo(e.target.files[0]));
  $('#voiceCancelBtn').addEventListener('click', cancelVoiceRecord);
  $('#voiceSendBtn').addEventListener('click', () => stopVoiceRecord(true));

  // 管理员
  $('#closeAdmin').addEventListener('click', () => $('#adminModal').classList.add('hidden'));
  $('#adminModal').addEventListener('click', (e) => { if (e.target.dataset.close) $('#adminModal').classList.add('hidden'); });
  $('#adminTable').addEventListener('click', (e) => {
    const t = e.target;
    if (t.dataset.ban) adminAction('ban', t.dataset.ban);
    else if (t.dataset.unban) adminAction('unban', t.dataset.unban);
    else if (t.dataset.role) adminAction('role', t.dataset.role, { role: t.dataset.r });
    else if (t.dataset.impersonate) adminAction('impersonate', t.dataset.impersonate);
  });

  // 忘记密码
  $('#closeForgot').addEventListener('click', () => { $('#forgotModal').classList.add('hidden'); clearInterval(forgotResendTimer); });
  $('#forgotModal').addEventListener('click', (e) => { if (e.target.dataset.close) { $('#forgotModal').classList.add('hidden'); clearInterval(forgotResendTimer); } });
  $('#sendCodeBtn').addEventListener('click', sendResetCode);
  $('#resendCodeBtn').addEventListener('click', resendCode);
  $('#resetPassBtn').addEventListener('click', doResetPassword);
}

async function init() {
  bind();
  bindExtra();
  applyGameUI();
  await loadConfig();
  loadModels();
  await bootAuth();
  if (state.user) route();
}

init();
