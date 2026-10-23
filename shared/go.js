// 围棋规则引擎 — 前后端共享
// 9 路盘，中国规则数子法（贴目 6.5 给白棋）
// 棋盘取值：0 空，1 黑，2 白

const SIZE = 9;
const KOMI = 6.5;

function create() {
  return new Uint8Array(SIZE * SIZE);
}

function index(x, y) {
  return y * SIZE + x;
}

function inside(x, y) {
  return x >= 0 && x < SIZE && y >= 0 && y < SIZE;
}

function neighbors(x, y) {
  const list = [];
  if (x > 0) list.push([x - 1, y]);
  if (x < SIZE - 1) list.push([x + 1, y]);
  if (y > 0) list.push([x, y - 1]);
  if (y < SIZE - 1) list.push([x, y + 1]);
  return list;
}

// 返回该点所在棋块 { stones: [idx], liberties: Set<idx> }
function groupAt(board, x, y) {
  const color = board[index(x, y)];
  if (!color) return { stones: [], liberties: new Set() };
  const seen = new Set([index(x, y)]);
  const liberties = new Set();
  const stack = [[x, y]];
  while (stack.length) {
    const [cx, cy] = stack.pop();
    for (const [nx, ny] of neighbors(cx, cy)) {
      const i = index(nx, ny);
      if (board[i] === 0) liberties.add(i);
      else if (board[i] === color && !seen.has(i)) {
        seen.add(i);
        stack.push([nx, ny]);
      }
    }
  }
  return { stones: Array.from(seen), liberties };
}

// 尝试落子，返回 { ok, board, captured, koPoint } 或 { error }
// 不修改传入棋盘，返回新棋盘
function play(board, x, y, color, koPoint) {
  if (!inside(x, y)) return { error: '落子位置越界' };
  const i = index(x, y);
  if (board[i] !== 0) return { error: '该位置已有棋子' };
  if (koPoint !== null && koPoint !== undefined && koPoint === i) {
    return { error: '打劫，不能立即提回' };
  }

  const next = Uint8Array.from(board);
  next[i] = color;
  const opp = 3 - color;
  const captured = [];
  const capturedSet = new Set();

  for (const [nx, ny] of neighbors(x, y)) {
    const ni = index(nx, ny);
    if (next[ni] !== opp || capturedSet.has(ni)) continue;
    const group = groupAt(next, nx, ny);
    if (group.liberties.size === 0) {
      for (const s of group.stones) {
        next[s] = 0;
        captured.push(s);
        capturedSet.add(s);
      }
    }
  }

  const own = groupAt(next, x, y);
  if (own.liberties.size === 0) return { error: '禁着点（自杀）' };

  // 单子提单子、且自身仅剩一气 → 形成劫
  let newKo = null;
  if (captured.length === 1 && own.stones.length === 1 && own.liberties.size === 1) {
    newKo = captured[0];
  }

  return { ok: true, board: next, captured, koPoint: newKo };
}

// 数子：棋块 + 围空，白棋加贴目
function score(board) {
  let black = 0;
  let white = 0;
  const visited = new Uint8Array(SIZE * SIZE);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const v = board[index(x, y)];
      if (v === 1) black++;
      else if (v === 2) white++;
    }
  }

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const start = index(x, y);
      if (board[start] !== 0 || visited[start]) continue;
      const region = [];
      const border = new Set();
      const stack = [[x, y]];
      visited[start] = 1;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        region.push(index(cx, cy));
        for (const [nx, ny] of neighbors(cx, cy)) {
          const ni = index(nx, ny);
          if (board[ni] === 0) {
            if (!visited[ni]) {
              visited[ni] = 1;
              stack.push([nx, ny]);
            }
          } else {
            border.add(board[ni]);
          }
        }
      }
      if (border.size === 1) {
        if (border.has(1)) black += region.length;
        else if (border.has(2)) white += region.length;
      }
    }
  }

  white += KOMI;
  return {
    black,
    white,
    diff: black - white,
    winner: black > white ? 1 : 2
  };
}

// ===================== AI =====================

function chebyshev(ax, ay, bx, by) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

function fillsOwnEye(board, x, y, color) {
  // 四邻全是己方（或边界）视作自己的眼，不去填
  let own = 0;
  let total = 0;
  for (const [nx, ny] of neighbors(x, y)) {
    total++;
    if (board[index(nx, ny)] === color) own++;
  }
  if (own !== total) return false;
  // 四条斜线也大多是己方，则更像眼
  let diagOwn = 0;
  let diagTotal = 0;
  for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const nx = x + dx;
    const ny = y + dy;
    if (!inside(nx, ny)) continue;
    diagTotal++;
    if (board[index(nx, ny)] === color) diagOwn++;
  }
  return diagTotal === 0 || diagOwn >= diagTotal * 0.5;
}

function starBonus(x, y) {
  const stars = [[2, 2], [6, 2], [2, 6], [6, 6], [4, 4], [2, 4], [4, 2], [4, 6], [6, 4]];
  return stars.some(([sx, sy]) => sx === x && sy === y) ? 3 : 0;
}

function nearestStone(board, x, y) {
  let best = 99;
  for (let yy = 0; yy < SIZE; yy++) {
    for (let xx = 0; xx < SIZE; xx++) {
      if (board[index(xx, yy)] === 0) continue;
      const d = chebyshev(x, y, xx, yy);
      if (d < best) best = d;
    }
  }
  return best;
}

// 返回 { x, y } 或 { pass: true }
function aiMove(board, color, koPoint, opponentPassed) {
  const opp = 3 - color;

  // 对方停一手时，若自己形势不差就直接停手结束
  if (opponentPassed) {
    const s = score(board);
    const lead = color === 1 ? s.black - s.white : s.white - s.black;
    if (lead >= -4) return { pass: true };
  }

  let best = null;
  let bestScore = -Infinity;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (board[index(x, y)] !== 0) continue;
      if (koPoint !== null && koPoint !== undefined && index(x, y) === koPoint) continue;
      if (fillsOwnEye(board, x, y, color)) continue;

      const result = play(board, x, y, color, koPoint);
      if (!result.ok) continue;

      let value = 0;
      value += result.captured.length * 14;

      const own = groupAt(result.board, x, y);
      value += Math.min(own.liberties.size, 6) * 1.7;
      if (own.liberties.size === 1) value -= 7;

      let ownN = 0;
      let oppN = 0;
      let emptyN = 0;
      for (const [nx, ny] of neighbors(x, y)) {
        const v = board[index(nx, ny)];
        if (v === color) ownN++;
        else if (v === opp) oppN++;
        else emptyN++;
      }
      value += ownN * 1.4 + oppN * 1.1 + emptyN * 0.15;

      // 提子威胁：对方棋子只剩一气时优先紧气
      for (const [nx, ny] of neighbors(x, y)) {
        if (board[index(nx, ny)] !== opp) continue;
        const g = groupAt(board, nx, ny);
        if (g.liberties.size === 1) value += 6;
      }

      const near = nearestStone(board, x, y);
      if (near === 99) value += starBonus(x, y) + 2;
      else value += Math.max(0, 4 - near) * 1.0;

      value += Math.random() * 0.8;

      if (value > bestScore) {
        bestScore = value;
        best = { x, y };
      }
    }
  }

  if (!best) return { pass: true };
  // 自己停手也不会更差，且没有好点：停一手
  if (bestScore < 1.2) {
    const s = score(board);
    const lead = color === 1 ? s.black - s.white : s.white - s.black;
    if (lead >= 0) return { pass: true };
  }
  return best;
}

module.exports = {
  SIZE,
  KOMI,
  create,
  index,
  inside,
  groupAt,
  play,
  score,
  aiMove
};
