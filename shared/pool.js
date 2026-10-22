// 桌球（8球）物理引擎与规则 — 前后端共享
// 坐标系：桌面左上角为原点，单位像素。桌面内边距即球桌可玩区域。

const TABLE = {
  width: 900,
  height: 500,
  cushion: 24,
  pocketRadius: 26,
  ballRadius: 13
};

const POCKETS = [
  { x: 0, y: 0 },
  { x: TABLE.width / 2, y: -6 },
  { x: TABLE.width, y: 0 },
  { x: 0, y: TABLE.height },
  { x: TABLE.width / 2, y: TABLE.height + 6 },
  { x: TABLE.width, y: TABLE.height }
];

const BALL_COLORS = {
  cue: '#f8f8f0',
  1: '#f5d300', 2: '#1a4fc4', 3: '#d42828', 4: '#5a2a8a',
  5: '#e87a1e', 6: '#0e7a3a', 7: '#8a1a1a', 8: '#111111',
  9: '#f5d300', 10: '#1a4fc4', 11: '#d42828', 12: '#5a2a8a',
  13: '#e87a1e', 14: '#0e7a3a', 15: '#8a1a1a'
};

function createRack() {
  const balls = [];
  const cx = TABLE.width * 0.72;
  const cy = TABLE.height / 2;
  const r = TABLE.ballRadius;
  const dx = r * 2 * 0.866;
  const dy = r * 2;

  // 三角 rack 球号（标准8球摆法：8号在中心，角落分别是实/花）
  const rack = [
    [1],
    [9, 2],
    [3, 8, 10],
    [11, 4, 12, 5],
    [6, 13, 14, 7, 15]
  ];

  for (let row = 0; row < rack.length; row++) {
    for (let col = 0; col < rack[row].length; col++) {
      const num = rack[row][col];
      const x = cx + row * dx;
      const y = cy + (col - (rack[row].length - 1) / 2) * dy;
      balls.push({
        id: num,
        number: num,
        x, y, vx: 0, vy: 0,
        type: num === 8 ? 'eight' : (num <= 7 ? 'solid' : 'stripe'),
        pocketed: false,
        radius: r,
        color: BALL_COLORS[num]
      });
    }
  }
  // 母球
  balls.push({
    id: 0, number: 0,
    x: TABLE.width * 0.25, y: cy, vx: 0, vy: 0,
    type: 'cue', pocketed: false, radius: r, color: BALL_COLORS.cue
  });
  return balls;
}

function createState() {
  return {
    balls: createRack(),
    turn: 1,
    phase: 'aiming', // aiming | simulating | gameover
    groups: { 1: null, 2: null }, // 'solid' | 'stripe'
    winner: 0,
    lastPocketed: [], // 本杆入袋的球
    breakShot: true,
    foul: false,
    foulReason: '',
    cushionHit: false
  };
}

function dist2(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}

// 物理单步模拟，返回是否还有球在动
function step(state, dt) {
  const balls = state.balls.filter((b) => !b.pocketed);
  const friction = 0.985;
  const minV = 0.05;
  let moving = false;

  // 积分位置
  for (const b of balls) {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.vx *= friction;
    b.vy *= friction;
    if (Math.abs(b.vx) < minV) b.vx = 0;
    if (Math.abs(b.vy) < minV) b.vy = 0;
    if (b.vx !== 0 || b.vy !== 0) moving = true;
  }

  // 库边碰撞
  const c = TABLE.cushion;
  const R = TABLE.ballRadius;
  for (const b of balls) {
    if (b.vx === 0 && b.vy === 0) continue;
    if (b.x < c + R) { b.x = c + R; b.vx = -b.vx * 0.92; state.cushionHit = true; }
    if (b.x > TABLE.width - c - R) { b.x = TABLE.width - c - R; b.vx = -b.vx * 0.92; state.cushionHit = true; }
    if (b.y < c + R) { b.y = c + R; b.vy = -b.vy * 0.92; state.cushionHit = true; }
    if (b.y > TABLE.height - c - R) { b.y = TABLE.height - c - R; b.vy = -b.vy * 0.92; state.cushionHit = true; }
  }

  // 球球碰撞
  for (let i = 0; i < balls.length; i++) {
    for (let j = i + 1; j < balls.length; j++) {
      const a = balls[i], b = balls[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      const minD = (a.radius + b.radius);
      if (d2 < minD * minD && d2 > 0.0001) {
        const d = Math.sqrt(d2);
        const nx = dx / d, ny = dy / d;
        // 分离重叠
        const overlap = minD - d;
        a.x -= nx * overlap / 2;
        a.y -= ny * overlap / 2;
        b.x += nx * overlap / 2;
        b.y += ny * overlap / 2;
        // 弹性碰撞（等质量）
        const dvx = b.vx - a.vx, dvy = b.vy - a.vy;
        const vn = dvx * nx + dvy * ny;
        if (vn < 0) {
          const impulse = vn;
          a.vx += impulse * nx;
          a.vy += impulse * ny;
          b.vx -= impulse * nx;
          b.vy -= impulse * ny;
        }
      }
    }
  }

  // 入袋检测
  for (const b of balls) {
    if (b.pocketed) continue;
    for (const p of POCKETS) {
      if (dist2(b, p) < (TABLE.pocketRadius - 2) * (TABLE.pocketRadius - 2)) {
        b.pocketed = true;
        b.vx = 0; b.vy = 0;
        state.lastPocketed.push(b);
        break;
      }
    }
  }

  return moving;
}

// 模拟一杆直到所有球停下（最多 maxSteps 步防死循环）
function simulateShot(state, maxSteps = 3000) {
  const dt = 1;
  state.lastPocketed = [];
  state.cushionHit = false;
  state.phase = 'simulating';
  let steps = 0;
  while (steps < maxSteps) {
    const moving = step(state, dt);
    steps++;
    if (!moving) break;
  }
  state.phase = 'aiming';
  return steps;
}

// 母球是否被入袋（犯规）
function cuePocketed(state) {
  return state.balls.some((b) => b.type === 'cue' && b.pocketed);
}

// 重置母球到开球区
function resetCue(state) {
  const cue = state.balls.find((b) => b.type === 'cue');
  if (!cue) return;
  cue.pocketed = false;
  cue.x = TABLE.width * 0.25;
  cue.y = TABLE.height / 2;
  cue.vx = 0; cue.vy = 0;
}

// 根据本杆结果判定：下一位选手、犯规、胜负
function resolveShot(state) {
  const shooter = state.turn;
  const opponent = 3 - shooter;
  const pocketed = state.lastPocketed;
  const cueIn = cuePocketed(state);

  // 母球入袋 → 犯规
  if (cueIn) {
    state.foul = true;
    state.foulReason = '母球落袋';
    resetCue(state);
  } else {
    state.foul = false;
    state.foulReason = '';
  }

  const nonCuePocketed = pocketed.filter((b) => b.type !== 'cue');

  // 开球杆后分组
  if (state.breakShot) {
    state.breakShot = false;
    if (!cueIn && nonCuePocketed.length > 0) {
      // 开球进了球，继续由开球方选择（简化：进什么就暂时归什么组）
      const firstType = nonCuePocketed[0].type;
      if (firstType !== 'eight') {
        state.groups[shooter] = firstType;
        state.groups[opponent] = firstType === 'solid' ? 'stripe' : 'solid';
      }
    }
  }

  // 未分组时，进第一个球决定分组
  if (!state.groups[shooter] && nonCuePocketed.length > 0 && !cueIn) {
    const firstType = nonCuePocketed[0].type;
    if (firstType !== 'eight') {
      state.groups[shooter] = firstType;
      state.groups[opponent] = firstType === 'solid' ? 'stripe' : 'solid';
    }
  }

  const myGroup = state.groups[shooter];
  const oppGroup = state.groups[opponent];

  // 8号球判定
  const eightPocketed = pocketed.some((b) => b.type === 'eight');
  if (eightPocketed) {
    // 自己组是否已全部打完
    const myBalls = state.balls.filter((b) => b.type === myGroup && !b.pocketed);
    if (myGroup && myBalls.length === 0 && !cueIn) {
      state.winner = shooter;
    } else {
      state.winner = opponent; // 提前打8号或母球同时落袋 → 输
    }
    state.phase = 'gameover';
    return;
  }

  // 判断本杆是否合法进球
  let legalPocket = false;
  if (myGroup) {
    legalPocket = nonCuePocketed.some((b) => b.type === myGroup);
  } else {
    legalPocket = nonCuePocketed.length > 0;
  }

  // 进了对手的球或花球但无自己球 → 不犯规但换手
  if (state.foul || !legalPocket) {
    state.turn = opponent;
  }
  // 合法进球 → 继续
}

// 应用一次击球
function applyShot(state, angle, power) {
  if (state.phase !== 'aiming') return { error: '现在不能击球' };
  if (state.turn === 0) return { error: '对局已结束' };
  const cue = state.balls.find((b) => b.type === 'cue' && !b.pocketed);
  if (!cue) return { error: '母球不在桌上' };
  const p = Math.max(2, Math.min(28, power));
  cue.vx = Math.cos(angle) * p;
  cue.vy = Math.sin(angle) * p;
  simulateShot(state);
  resolveShot(state);
  return { ok: true };
}

// AI 简单选球：找最容易进的袋，朝该球反方向打
function aiPickShot(state) {
  const cue = state.balls.find((b) => b.type === 'cue' && !b.pocketed);
  if (!cue) return null;
  const group = state.groups[2]; // AI 是 2 号
  let targets;
  if (group) {
    targets = state.balls.filter((b) => b.type === group && !b.pocketed);
  } else {
    targets = state.balls.filter((b) => b.type !== 'cue' && b.type !== 'eight' && !b.pocketed);
  }
  if (!targets.length) {
    targets = state.balls.filter((b) => b.type !== 'cue' && !b.pocketed);
  }
  if (!targets.length) return null;

  let best = null;
  let bestScore = -Infinity;
  for (const t of targets) {
    // 对每个袋，计算击球角度
    for (const p of POCKETS) {
      // 目标球到袋的方向
      const tx = p.x - t.x, ty = p.y - t.y;
      const tl = Math.hypot(tx, ty);
      if (tl < 1) continue;
      // 母球应击打的目标球接触点 = 目标球位置 - (球到袋方向 * 球直径)
      const hitX = t.x - (tx / tl) * (TABLE.ballRadius * 2);
      const hitY = t.y - (ty / tl) * (TABLE.ballRadius * 2);
      // 母球到击打点的方向
      const angle = Math.atan2(hitY - cue.y, hitX - cue.x);
      const dist = Math.hypot(hitX - cue.x, hitY - cue.y);
      // 简化评分：距离越近越好
      const score = -dist + Math.random() * 30;
      if (score > bestScore) {
        bestScore = score;
        best = { angle, power: Math.min(22, 10 + dist * 0.04) };
      }
    }
  }
  return best || { angle: Math.random() * Math.PI * 2, power: 14 };
}

module.exports = {
  TABLE, POCKETS, BALL_COLORS,
  createState, applyShot, aiPickShot,
  cuePocketed, resetCue, simulateShot
};
