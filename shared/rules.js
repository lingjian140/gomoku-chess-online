/**
 * 共享棋规：五子棋 + 中国象棋
 * 同时供 Node 服务端（require）与浏览器（window.GameRules）使用。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GameRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ------------------------------------------------------------ 五子棋
  var G_SIZE = 15;
  var G_CELLS = G_SIZE * G_SIZE;
  var G_DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

  function gIndex(x, y) {
    return y * G_SIZE + x;
  }

  function gInside(x, y) {
    return x >= 0 && x < G_SIZE && y >= 0 && y < G_SIZE;
  }

  function gCreate() {
    return new Uint8Array(G_CELLS);
  }

  function gCheckWin(board, x, y, color) {
    for (var d = 0; d < G_DIRS.length; d++) {
      var dx = G_DIRS[d][0];
      var dy = G_DIRS[d][1];
      var line = [[x, y]];
      var step;
      for (step = 1; step < G_SIZE; step++) {
        var nx = x + dx * step;
        var ny = y + dy * step;
        if (!gInside(nx, ny) || board[gIndex(nx, ny)] !== color) break;
        line.push([nx, ny]);
      }
      for (step = 1; step < G_SIZE; step++) {
        var bx = x - dx * step;
        var by = y - dy * step;
        if (!gInside(bx, by) || board[gIndex(bx, by)] !== color) break;
        line.unshift([bx, by]);
      }
      if (line.length >= 5) return line;
    }
    return null;
  }

  // ------------------------------------------------------------ 象棋
  var C_W = 9;
  var C_H = 10;

  var INIT_ROWS = [
    'rnbakabnr',
    '.........',
    '.c.....c.',
    'p.p.p.p.p',
    '.........',
    '.........',
    'P.P.P.P.P',
    '.C.....C.',
    '.........',
    'RNBAKABNR'
  ];

  function cIndex(x, y) {
    return y * C_W + x;
  }

  function cInBoard(x, y) {
    return x >= 0 && x < C_W && y >= 0 && y < C_H;
  }

  function pieceColor(piece) {
    if (!piece) return '';
    return piece === piece.toUpperCase() ? 'r' : 'b';
  }

  function sideToPlayer(side) {
    return side === 'r' ? 1 : 2;
  }

  function playerToSide(color) {
    return color === 1 ? 'r' : 'b';
  }

  function cCreate() {
    var board = new Array(C_W * C_H).fill('');
    for (var y = 0; y < INIT_ROWS.length; y++) {
      for (var x = 0; x < C_W; x++) {
        var ch = INIT_ROWS[y][x];
        if (ch !== '.') board[cIndex(x, y)] = ch;
      }
    }
    return board;
  }

  function inPalace(x, y, side) {
    if (x < 3 || x > 5) return false;
    return side === 'r' ? y >= 7 && y <= 9 : y <= 2;
  }

  function crossedRiver(y, side) {
    return side === 'r' ? y <= 4 : y >= 5;
  }

  var KING_STEPS = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  var ADVISOR_STEPS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  var ORTHO = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  var HORSE_STEPS = [
    [1, 2, 0, 1], [-1, 2, 0, 1], [1, -2, 0, -1], [-1, -2, 0, -1],
    [2, 1, 1, 0], [2, -1, 1, 0], [-2, 1, -1, 0], [-2, -1, -1, 0]
  ];

  /** 生成伪合法走法（不检查是否自将 / 将帅照面） */
  function pseudoMoves(board, x, y) {
    var piece = board[cIndex(x, y)];
    if (!piece) return [];
    var side = pieceColor(piece);
    var type = piece.toUpperCase();
    var out = [];

    function free(nx, ny) {
      if (!cInBoard(nx, ny)) return false;
      var target = board[cIndex(nx, ny)];
      return !target || pieceColor(target) !== side;
    }

    function add(nx, ny) {
      if (free(nx, ny)) out.push({ x: nx, y: ny });
    }

    var i, nx, ny, target;
    if (type === 'K') {
      for (i = 0; i < KING_STEPS.length; i++) {
        nx = x + KING_STEPS[i][0];
        ny = y + KING_STEPS[i][1];
        if (inPalace(nx, ny, side)) add(nx, ny);
      }
    } else if (type === 'A') {
      for (i = 0; i < ADVISOR_STEPS.length; i++) {
        nx = x + ADVISOR_STEPS[i][0];
        ny = y + ADVISOR_STEPS[i][1];
        if (inPalace(nx, ny, side)) add(nx, ny);
      }
    } else if (type === 'B') {
      for (i = 0; i < ADVISOR_STEPS.length; i++) {
        var ex = x + ADVISOR_STEPS[i][0];
        var ey = y + ADVISOR_STEPS[i][1];
        nx = x + ADVISOR_STEPS[i][0] * 2;
        ny = y + ADVISOR_STEPS[i][1] * 2;
        if (!cInBoard(nx, ny)) continue;
        // 象眼不能有子
        if (board[cIndex(ex, ey)]) continue;
        // 象不过河
        if (side === 'r' ? ny < 5 : ny > 4) continue;
        add(nx, ny);
      }
    } else if (type === 'N') {
      for (i = 0; i < HORSE_STEPS.length; i++) {
        var hx = HORSE_STEPS[i][0];
        var hy = HORSE_STEPS[i][1];
        var lx = HORSE_STEPS[i][2];
        var ly = HORSE_STEPS[i][3];
        if (board[cIndex(x + lx, y + ly)]) continue; // 蹩马腿
        add(x + hx, y + hy);
      }
    } else if (type === 'R') {
      for (i = 0; i < ORTHO.length; i++) {
        nx = x + ORTHO[i][0];
        ny = y + ORTHO[i][1];
        while (cInBoard(nx, ny)) {
          target = board[cIndex(nx, ny)];
          if (!target) {
            out.push({ x: nx, y: ny });
          } else {
            if (pieceColor(target) !== side) out.push({ x: nx, y: ny });
            break;
          }
          nx += ORTHO[i][0];
          ny += ORTHO[i][1];
        }
      }
    } else if (type === 'C') {
      for (i = 0; i < ORTHO.length; i++) {
        var dx = ORTHO[i][0];
        var dy = ORTHO[i][1];
        nx = x + dx;
        ny = y + dy;
        var screened = false;
        while (cInBoard(nx, ny)) {
          target = board[cIndex(nx, ny)];
          if (!screened) {
            if (!target) out.push({ x: nx, y: ny });
            else screened = true;
          } else if (target) {
            if (pieceColor(target) !== side) out.push({ x: nx, y: ny });
            break;
          }
          nx += dx;
          ny += dy;
        }
      }
    } else if (type === 'P') {
      var forward = side === 'r' ? -1 : 1;
      add(x, y + forward);
      if (crossedRiver(y, side)) {
        add(x - 1, y);
        add(x + 1, y);
      }
    }
    return out;
  }

  function findGeneral(board, side) {
    var target = side === 'r' ? 'K' : 'k';
    for (var i = 0; i < board.length; i++) {
      if (board[i] === target) {
        return { x: i % C_W, y: Math.floor(i / C_W) };
      }
    }
    return null;
  }

  /** 将帅照面（同列且中间无子） */
  function generalsFace(board) {
    var rk = findGeneral(board, 'r');
    var bk = findGeneral(board, 'b');
    if (!rk || !bk || rk.x !== bk.x) return false;
    var from = Math.min(rk.y, bk.y) + 1;
    var to = Math.max(rk.y, bk.y);
    for (var y = from; y < to; y++) {
      if (board[cIndex(rk.x, y)]) return false;
    }
    return true;
  }

  function isInCheck(board, side) {
    var general = findGeneral(board, side);
    if (!general) return true;
    if (generalsFace(board)) return true;
    var enemy = side === 'r' ? 'b' : 'r';
    for (var i = 0; i < board.length; i++) {
      var piece = board[i];
      if (!piece || pieceColor(piece) !== enemy) continue;
      var moves = pseudoMoves(board, i % C_W, Math.floor(i / C_W));
      for (var m = 0; m < moves.length; m++) {
        if (moves[m].x === general.x && moves[m].y === general.y) return true;
      }
    }
    return false;
  }

  function cloneBoard(board) {
    return board.slice();
  }

  /** 走子后自己是否安全（不送将、不照面） */
  function moveKeepsSafe(board, from, to, side) {
    var copy = cloneBoard(board);
    copy[cIndex(to.x, to.y)] = copy[cIndex(from.x, from.y)];
    copy[cIndex(from.x, from.y)] = '';
    return !isInCheck(copy, side);
  }

  function legalMoves(board, x, y) {
    var piece = board[cIndex(x, y)];
    if (!piece) return [];
    var side = pieceColor(piece);
    var from = { x: x, y: y };
    return pseudoMoves(board, x, y).filter(function (move) {
      return moveKeepsSafe(board, from, move, side);
    });
  }

  function isLegalMove(board, from, to) {
    if (!from || !to || !cInBoard(from.x, from.y) || !cInBoard(to.x, to.y)) return false;
    var piece = board[cIndex(from.x, from.y)];
    if (!piece) return false;
    return legalMoves(board, from.x, from.y).some(function (move) {
      return move.x === to.x && move.y === to.y;
    });
  }

  /** 原地执行走子，返回被吃子信息 */
  function applyMove(board, from, to) {
    var piece = board[cIndex(from.x, from.y)];
    var captured = board[cIndex(to.x, to.y)];
    board[cIndex(to.x, to.y)] = piece;
    board[cIndex(from.x, from.y)] = '';
    return {
      piece: piece,
      captured: captured,
      capturedGeneral: Boolean(captured && captured.toUpperCase() === 'K'),
      side: pieceColor(piece)
    };
  }

  function hasLegalMove(board, side) {
    for (var i = 0; i < board.length; i++) {
      var piece = board[i];
      if (!piece || pieceColor(piece) !== side) continue;
      if (legalMoves(board, i % C_W, Math.floor(i / C_W)).length) return true;
    }
    return false;
  }

  return {
    Gomoku: {
      SIZE: G_SIZE,
      CELLS: G_CELLS,
      index: gIndex,
      inside: gInside,
      create: gCreate,
      checkWin: gCheckWin
    },
    Chess: {
      WIDTH: C_W,
      HEIGHT: C_H,
      SIZE: C_W * C_H,
      create: cCreate,
      index: cIndex,
      inBoard: cInBoard,
      pieceColor: pieceColor,
      sideToPlayer: sideToPlayer,
      playerToSide: playerToSide,
      pseudoMoves: pseudoMoves,
      legalMoves: legalMoves,
      isLegalMove: isLegalMove,
      applyMove: applyMove,
      findGeneral: findGeneral,
      generalsFace: generalsFace,
      isInCheck: isInCheck,
      hasLegalMove: hasLegalMove,
      cloneBoard: cloneBoard
    }
  };
});
