// 斗地主规则引擎 — 前后端共享
// 牌值：3=3 ... 15=2, 16=小王, 17=大王
// 花色：0♠ 1♥ 2♣ 3♦，王无花色

const SUITS = ['♠', '♥', '♣', '♦'];
const NAMES = { 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王' };

function createDeck() {
  const deck = [];
  let id = 0;
  for (let v = 3; v <= 15; v++) {
    for (let s = 0; s < 4; s++) deck.push({ id: id++, v, s });
  }
  deck.push({ id: id++, v: 16, s: -1 }); // 小王
  deck.push({ id: id++, v: 17, s: -1 }); // 大王
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function createState() {
  const deck = shuffle(createDeck());
  const hands = { 1: [], 2: [], 3: [] };
  for (let i = 0; i < 51; i++) hands[(i % 3) + 1].push(deck[i]);
  const landlordCards = deck.slice(51, 54);
  for (const k of [1, 2, 3]) sortHand(hands[k]);
  return {
    phase: 'bidding', // bidding | playing | finished
    hands,
    landlordCards,
    landlord: 0,
    bidder: 1,
    bids: { 1: null, 2: null, 3: null },
    currentBid: 0,
    turn: 1,
    lastPlay: null, // { seat, cards, type, main, length }
    passes: 0,
    winner: 0, // 0 | 'landlord' | 'peasants'
    playCount: 0
  };
}

function sortHand(hand) {
  hand.sort((a, b) => a.v - b.v || a.s - b.s);
}

// 统计每个点数的张数
function countByValue(cards) {
  const m = {};
  for (const c of cards) m[c.v] = (m[c.v] || 0) + 1;
  return m;
}

// 识别牌型，返回 { type, main, length } 或 null
// type: single, pair, triple, triple1, triple2, straight, pairsStraight,
//       plane, planeSingle, planePair, four2, bomb, rocket
function detect(cards) {
  if (!cards || !cards.length) return null;
  const n = cards.length;
  const counts = countByValue(cards);
  const values = Object.keys(counts).map(Number).sort((a, b) => a - b);
  const groups = []; // [value, count]
  for (const v of values) groups.push([v, counts[v]]);
  const byCount = {};
  for (const [v, c] of groups) (byCount[c] = byCount[c] || []).push(v);

  // 王炸
  if (n === 2 && counts[16] && counts[17]) return { type: 'rocket', main: 17, length: 2 };
  // 炸弹
  if (n === 4 && byCount[4] && byCount[4].length === 1) return { type: 'bomb', main: byCount[4][0], length: 4 };
  // 单张
  if (n === 1) return { type: 'single', main: values[0], length: 1 };
  // 对子
  if (n === 2 && byCount[2] && byCount[2].length === 1) return { type: 'pair', main: byCount[2][0], length: 2 };
  // 三张
  if (n === 3 && byCount[3] && byCount[3].length === 1) return { type: 'triple', main: byCount[3][0], length: 3 };
  // 三带一
  if (n === 4 && byCount[3] && byCount[3].length === 1 && byCount[1] && byCount[1].length === 1) {
    return { type: 'triple1', main: byCount[3][0], length: 3 };
  }
  // 三带二
  if (n === 5 && byCount[3] && byCount[3].length === 1 && byCount[2] && byCount[2].length === 1) {
    return { type: 'triple2', main: byCount[3][0], length: 3 };
  }
  // 顺子（5+ 连续单张，不含 2/王）
  if (n >= 5 && byCount[1] && byCount[1].length === n) {
    const vs = byCount[1].slice().sort((a, b) => a - b);
    if (vs[vs.length - 1] <= 14 && isConsecutive(vs)) return { type: 'straight', main: vs[0], length: n };
  }
  // 连对（3+ 连续对子，不含 2/王）
  if (n >= 6 && n % 2 === 0 && byCount[2] && byCount[2].length === n / 2) {
    const vs = byCount[2].slice().sort((a, b) => a - b);
    if (vs[vs.length - 1] <= 14 && isConsecutive(vs)) return { type: 'pairsStraight', main: vs[0], length: n / 2 };
  }
  // 飞机（2+ 连续三张）
  if (byCount[3] && byCount[3].length >= 2) {
    const vs = byCount[3].slice().sort((a, b) => a - b);
    const consec = longestConsecutive(vs);
    if (consec.length >= 2) {
      const k = consec.length;
      // 飞机不带
      if (n === k * 3) return { type: 'plane', main: consec[0], length: k };
      // 飞机带单
      if (n === k * 4) return { type: 'planeSingle', main: consec[0], length: k };
      // 飞机带对
      if (n === k * 5 && byCount[2] && byCount[2].length >= k) {
        // 确保带的对子不是飞机本身的（已经在 byCount[3] 里，不会在 byCount[2]）
        return { type: 'planePair', main: consec[0], length: k };
      }
    }
  }
  // 四带二（两张单或两对）
  if (byCount[4] && byCount[4].length === 1) {
    if (n === 6) return { type: 'four2', main: byCount[4][0], length: 4 };
  }
  return null;
}

function isConsecutive(arr) {
  for (let i = 1; i < arr.length; i++) if (arr[i] !== arr[i - 1] + 1) return false;
  return true;
}

function longestConsecutive(arr) {
  let best = [], cur = [arr[0]];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] === arr[i - 1] + 1) cur.push(arr[i]);
    else { if (cur.length > best.length) best = cur; cur = [arr[i]]; }
  }
  return cur.length > best.length ? cur : best;
}

// 判断 play 是否能压过 last
function canBeat(play, last) {
  if (!last) return true;
  if (play.type === 'rocket') return true;
  if (last.type === 'rocket') return false;
  if (play.type === 'bomb' && last.type !== 'bomb') return true;
  if (play.type === 'bomb' && last.type === 'bomb') return play.main > last.main;
  if (play.type !== last.type) return false;
  if (play.length !== last.length) return false;
  return play.main > last.main;
}

// 应用一次叫分
function applyBid(state, seat, bid) {
  if (state.phase !== 'bidding') return { error: '不在叫分阶段' };
  if (state.bidder !== seat) return { error: '还没轮到你叫分' };
  if (bid !== 0 && bid !== 1 && bid !== 2 && bid !== 3) return { error: '叫分无效' };
  if (bid !== 0 && bid <= state.currentBid) return { error: '叫分必须大于当前' };
  state.bids[seat] = bid;
  if (bid > state.currentBid) state.currentBid = bid;
  // 叫 3 直接当地主
  if (bid === 3) {
    finishBidding(state, seat);
    return { ok: true };
  }
  // 下一位
  state.bidder = (seat % 3) + 1;
  // 若三人都叫过
  const allBid = state.bids[1] !== null && state.bids[2] !== null && state.bids[3] !== null;
  if (allBid) {
    // 找最高分
    let top = 0, topSeat = 0;
    for (const s of [1, 2, 3]) if (state.bids[s] > top) { top = state.bids[s]; topSeat = s; }
    if (topSeat === 0) {
      // 都不叫，重新发牌
      Object.assign(state, createState());
      return { ok: true, redeal: true };
    }
    finishBidding(state, topSeat);
  }
  return { ok: true };
}

function finishBidding(state, landlordSeat) {
  state.landlord = landlordSeat;
  state.phase = 'playing';
  state.turn = landlordSeat;
  state.hands[landlordSeat] = state.hands[landlordSeat].concat(state.landlordCards);
  sortHand(state.hands[landlordSeat]);
  state.lastPlay = null;
  state.passes = 0;
}

// 应用出牌
function applyPlay(state, seat, cardIds) {
  if (state.phase !== 'playing') return { error: '不在出牌阶段' };
  if (state.turn !== seat) return { error: '还没轮到你出牌' };
  const hand = state.hands[seat];
  const cards = cardIds.map((id) => hand.find((c) => c.id === id)).filter(Boolean);
  if (cards.length !== cardIds.length) return { error: '手牌中没有这些牌' };

  // 不要（空）
  if (cardIds.length === 0) {
    if (!state.lastPlay) return { error: '你是领出方，必须出牌' };
    state.passes++;
    state.turn = (seat % 3) + 1;
    // 另外两家都不要 → 领出方重新出
    if (state.passes >= 2) {
      state.lastPlay = null;
      state.passes = 0;
    }
    return { ok: true };
  }

  const pattern = detect(cards);
  if (!pattern) return { error: '牌型不合法' };
  if (state.lastPlay && state.lastPlay.seat !== seat && !canBeat(pattern, state.lastPlay)) {
    return { error: '压不过上家的牌' };
  }

  // 移除手牌
  for (const c of cards) {
    const idx = hand.findIndex((h) => h.id === c.id);
    if (idx >= 0) hand.splice(idx, 1);
  }
  state.playCount++;
  state.lastPlay = { seat, cards, type: pattern.type, main: pattern.main, length: pattern.length };
  state.passes = 0;

  // 胜负判定
  if (hand.length === 0) {
    state.phase = 'finished';
    state.winner = seat === state.landlord ? 'landlord' : 'peasants';
    return { ok: true, win: true };
  }
  state.turn = (seat % 3) + 1;
  return { ok: true };
}

// ===================== AI =====================

// 手牌强度评估（用于叫分）
function handStrength(hand) {
  let score = 0;
  const counts = countByValue(hand);
  // 王炸
  if (counts[16] && counts[17]) score += 8;
  else if (counts[16] || counts[17]) score += 3;
  // 2
  score += (counts[15] || 0) * 2;
  // A
  score += (counts[14] || 0) * 1;
  // 炸弹
  for (const v in counts) if (counts[v] === 4 && v <= 15) score += 6;
  // 三张
  let triples = 0;
  for (const v in counts) if (counts[v] === 3) triples++;
  score += triples * 1.5;
  // 顺子潜力
  const singles = Object.keys(counts).filter((v) => counts[v] >= 1 && v <= 14).map(Number).sort((a, b) => a - b);
  let run = 1, maxRun = 1;
  for (let i = 1; i < singles.length; i++) {
    if (singles[i] === singles[i - 1] + 1) { run++; maxRun = Math.max(maxRun, run); }
    else run = 1;
  }
  if (maxRun >= 5) score += 2;
  return score;
}

function aiBid(state, seat) {
  const score = handStrength(state.hands[seat]);
  // 简单阈值
  if (score >= 12) return 3;
  if (score >= 8 && state.currentBid < 2) return 2;
  if (score >= 5 && state.currentBid < 1) return 1;
  // 若已经有人叫分且自己不够强，pass
  if (state.currentBid > 0) return 0;
  // 没人叫，弱牌也叫 1 分防止流局（30% 概率）
  return Math.random() < 0.3 ? 1 : 0;
}

// 从手牌中找出能压过 last 的最小出牌
function findBeat(hand, last) {
  const counts = countByValue(hand);
  const values = Object.keys(counts).map(Number).sort((a, b) => a - b);
  const byCount = {};
  for (const v of values) (byCount[counts[v]] = byCount[counts[v]] || []).push(v);

  if (!last) {
    // 领出：出最小的牌型，优先单张小牌
    return leadSmallest(hand, counts, byCount, values);
  }

  // 王炸
  if (last.type !== 'rocket' && counts[16] && counts[17]) {
    return hand.filter((c) => c.v >= 16);
  }
  // 炸弹
  if (last.type !== 'bomb' && last.type !== 'rocket') {
    const bombs = (byCount[4] || []).filter((v) => v <= 15);
    if (bombs.length) {
      const v = bombs[0];
      return hand.filter((c) => c.v === v);
    }
  }
  if (last.type === 'bomb') {
    const bombs = (byCount[4] || []).filter((v) => v > last.main && v <= 15);
    if (bombs.length) {
      const v = bombs[0];
      return hand.filter((c) => c.v === v);
    }
    return null;
  }

  // 同型压牌
  switch (last.type) {
    case 'single': {
      const cands = values.filter((v) => v > last.main);
      if (!cands.length) return null;
      return [hand.find((c) => c.v === cands[0])];
    }
    case 'pair': {
      const cands = (byCount[2] || []).filter((v) => v > last.main);
      if (!cands.length) return null;
      return hand.filter((c) => c.v === cands[0]);
    }
    case 'triple': {
      const cands = (byCount[3] || []).filter((v) => v > last.main);
      if (!cands.length) return null;
      return hand.filter((c) => c.v === cands[0]);
    }
    case 'triple1': {
      const cands = (byCount[3] || []).filter((v) => v > last.main);
      for (const v of cands) {
        const kicker = values.find((kv) => kv !== v && counts[kv] >= 1);
        if (kicker !== undefined) {
          const triple = hand.filter((c) => c.v === v);
          const k = hand.find((c) => c.v === kicker);
          return [...triple, k];
        }
      }
      return null;
    }
    case 'triple2': {
      const cands = (byCount[3] || []).filter((v) => v > last.main);
      for (const v of cands) {
        const pairV = (byCount[2] || []).find((pv) => pv !== v);
        if (pairV !== undefined) {
          const triple = hand.filter((c) => c.v === v);
          const pair = hand.filter((c) => c.v === pairV);
          return [...triple, ...pair];
        }
      }
      return null;
    }
    case 'straight': {
      const len = last.length;
      const vs = values.filter((v) => v <= 14 && counts[v] >= 1);
      for (let start = last.main + 1; start + len - 1 <= 14; start++) {
        let ok = true;
        for (let i = 0; i < len; i++) if (!vs.includes(start + i)) { ok = false; break; }
        if (ok) {
          const out = [];
          for (let i = 0; i < len; i++) out.push(hand.find((c) => c.v === start + i));
          return out;
        }
      }
      return null;
    }
    case 'pairsStraight': {
      const len = last.length;
      const ps = (byCount[2] || []).filter((v) => v <= 14);
      for (let start = last.main + 1; start + len - 1 <= 14; start++) {
        let ok = true;
        for (let i = 0; i < len; i++) if (!ps.includes(start + i)) { ok = false; break; }
        if (ok) {
          const out = [];
          for (let i = 0; i < len; i++) out.push(...hand.filter((c) => c.v === start + i));
          return out;
        }
      }
      return null;
    }
    case 'plane':
    case 'planeSingle':
    case 'planePair': {
      const len = last.length;
      const ts = (byCount[3] || []).filter((v) => v <= 14);
      for (let start = last.main + 1; start + len - 1 <= 14; start++) {
        let ok = true;
        for (let i = 0; i < len; i++) if (!ts.includes(start + i)) { ok = false; break; }
        if (ok) {
          const triples = [];
          for (let i = 0; i < len; i++) triples.push(...hand.filter((c) => c.v === start + i));
          if (last.type === 'plane') return triples;
          if (last.type === 'planeSingle') {
            // 带 len 张单
            const used = new Set(triples.map((c) => c.id));
            const rest = hand.filter((c) => !used.has(c.id));
            if (rest.length >= len) return [...triples, ...rest.slice(0, len)];
          }
          if (last.type === 'planePair') {
            const usedV = new Set();
            for (let i = 0; i < len; i++) usedV.add(start + i);
            const pairVs = (byCount[2] || []).filter((v) => !usedV.has(v));
            if (pairVs.length >= len) {
              const out = [...triples];
              for (let i = 0; i < len; i++) out.push(...hand.filter((c) => c.v === pairVs[i]));
              return out;
            }
          }
        }
      }
      return null;
    }
    case 'four2': {
      const cands = (byCount[4] || []).filter((v) => v > last.main && v <= 15);
      for (const v of cands) {
        const four = hand.filter((c) => c.v === v);
        const rest = hand.filter((c) => c.v !== v);
        if (rest.length >= 2) return [...four, ...rest.slice(0, 2)];
      }
      return null;
    }
  }
  return null;
}

function leadSmallest(hand, counts, byCount, values) {
  // 优先出最小的单张（避免拆对/拆三）
  const singleVs = values.filter((v) => counts[v] === 1 && v < 16);
  if (singleVs.length) {
    const v = singleVs[0];
    return [hand.find((c) => c.v === v)];
  }
  // 最小对子
  const pairVs = (byCount[2] || []).filter((v) => v < 16);
  if (pairVs.length) return hand.filter((c) => c.v === pairVs[0]);
  // 最小三张
  const tripleVs = (byCount[3] || []).filter((v) => v < 16);
  if (tripleVs.length) return hand.filter((c) => c.v === tripleVs[0]);
  // 随便出最小单张
  return [hand.find((c) => c.v === values[0])];
}

function aiPlay(state, seat) {
  const hand = state.hands[seat];
  const isLandlord = seat === state.landlord;
  // 如果是领出方
  if (!state.lastPlay || state.lastPlay.seat === seat) {
    const counts = countByValue(hand);
    const values = Object.keys(counts).map(Number).sort((a, b) => a - b);
    const byCount = {};
    for (const v of values) (byCount[counts[v]] = byCount[counts[v]] || []).push(v);
    return leadSmallest(hand, counts, byCount, values).map((c) => c.id);
  }
  // 跟牌
  const beat = findBeat(hand, state.lastPlay);
  if (!beat) return []; // 不要

  // 策略：如果队友（农民同伴）是上一手出牌的人且手牌少，不压
  if (!isLandlord) {
    const lastSeat = state.lastPlay.seat;
    const lastIsPartner = lastSeat !== state.landlord && lastSeat !== seat;
    if (lastIsPartner && state.hands[lastSeat].length <= 3) return [];
  }
  // 地主不轻易炸
  return beat.map((c) => c.id);
}

module.exports = {
  SUITS, NAMES,
  createDeck, createState, shuffle, sortHand,
  detect, canBeat, applyBid, applyPlay,
  aiBid, aiPlay, handStrength
};
