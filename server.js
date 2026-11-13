
// Servidor do VTT: serve /public e sincroniza o estado via WebSocket.
// Rodar: npm install && npm start -> http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const GM_PASS = process.env.GM_PASS || 'mestre123';

const FILE = path.join(__dirname, 'data.json');
const MAPFILE = path.join(__dirname, 'map.txt');

// ---------- Estado ----------
let state = {
  grid: {
    size: 50,
    ox: 0,
    oy: 0,
    opacity: 0.35,
    color: '#ffffff',
    show: true
  },

  map: {
    has: false,
    scale: 1,
    ox: 0,
    oy: 0
  },

  sheets: [],
  order: [],
  turn: 0,
  nextId: 1,

  // Fog of War: guarda somente os quadrados cobertos.
  // Cada posição é representada por { x, y }.
  fog: {
    cells: []
  },

  // Combate (FFRPG 3e)
  combat: {
    active: false,
    round: 0,
    phase: 'idle',
    entries: [],
    cur: 0,
    effects: [],
    nextEff: 1,
    ticked: false
  }
};

// Carrega os dados existentes.
try {
  const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  state = Object.assign(state, saved);
} catch {}

// Garante que mesas antigas também tenham a estrutura da névoa.
if (!state.fog || typeof state.fog !== 'object') {
  state.fog = { cells: [] };
}

if (!Array.isArray(state.fog.cells)) {
  state.fog.cells = [];
}

// Remove possíveis posições inválidas salvas anteriormente.
state.fog.cells = state.fog.cells.filter(cell =>
  cell &&
  Number.isSafeInteger(cell.x) &&
  Number.isSafeInteger(cell.y)
);

let mapSrc = '';

try {
  mapSrc = fs.readFileSync(MAPFILE, 'utf8');
} catch {}

let timer;

const save = () => {
  clearTimeout(timer);

  timer = setTimeout(() => {
    fs.writeFile(FILE, JSON.stringify(state), () => {});
  }, 500);
};

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const pub = path.join(__dirname, 'public');

  const file = path.join(
    pub,
    req.url === '/' ? 'index.html' : req.url.split('?')[0]
  );

  if (!file.startsWith(pub)) {
    res.writeHead(403);
    return res.end();
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Não encontrado');
    }

    res.writeHead(200, {
      'Content-Type': file.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : 'text/plain'
    });

    res.end(data);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({
  server,
  maxPayload: 15 * 1024 * 1024
});

const send = (ws, msg) =>
  ws.readyState === 1 && ws.send(JSON.stringify(msg));

const broadcast = msg =>
  wss.clients.forEach(client => {
    if (client.user) send(client, msg);
  });

const sync = () => {
  broadcast({ t: 'state', state });
  save();
};

const d = n => 1 + Math.floor(Math.random() * n);

const num = (v, def = 0) =>
  Number.isFinite(+v) ? +v : def;

const TOP_TEXT = ['name', 'color'];
const TOP_NUM = ['hp', 'maxHp', 'mp', 'maxMp', 'xp', 'maxXp'];

function isRepeatableData(value) {
  return Array.isArray(value) &&
    value.length <= 1000 &&
    value.every(row =>
      row &&
      typeof row === 'object' &&
      !Array.isArray(row) &&
      Object.values(row).every(cell =>
        (typeof cell === 'string' && cell.length <= 3000) ||
        (typeof cell === 'number' && Number.isFinite(cell))
      )
    );
}

// ---------- FOG OF WAR ----------

// Limites de segurança para as operações da névoa.
const FOG_MAX_CELLS_PER_ACTION = 5000;
const FOG_MAX_TOTAL_CELLS = 200000;
const FOG_COORD_LIMIT = 1000000;

// Verifica e normaliza as posições recebidas.
function validFogCells(cells) {
  if (!Array.isArray(cells)) return null;

  if (cells.length > FOG_MAX_CELLS_PER_ACTION) {
    return null;
  }

  const result = [];
  const seen = new Set();

  for (const cell of cells) {
    if (!cell || typeof cell !== 'object') continue;

    const x = cell.x;
    const y = cell.y;

    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
      continue;
    }

    if (
      Math.abs(x) > FOG_COORD_LIMIT ||
      Math.abs(y) > FOG_COORD_LIMIT
    ) {
      continue;
    }

    const key = `${x},${y}`;

    if (seen.has(key)) continue;

    seen.add(key);
    result.push({ x, y });
  }

  return result;
}

// Aplica uma operação de névoa.
// IMPORTANTE: somente o mestre pode executar essas ações.
function handleFog(m, user) {
  if (!user.gm) return false;

  if (!state.fog || !Array.isArray(state.fog.cells)) {
    state.fog = { cells: [] };
  }

  const op = m.op;

  // Limpa toda a névoa.
  if (op === 'clear') {
    state.fog.cells = [];
    return true;
  }

  // Somente paint e reveal são aceitos além de clear.
  if (op !== 'paint' && op !== 'reveal') {
    return false;
  }

  const cells = validFogCells(m.cells);

  if (!cells || cells.length === 0) {
    return false;
  }

  const current = new Map(
    state.fog.cells.map(cell => [
      `${cell.x},${cell.y}`,
      cell
    ])
  );

  if (op === 'paint') {
    for (const cell of cells) {
      const key = `${cell.x},${cell.y}`;

      if (current.has(key)) continue;

      // Impede crescimento ilimitado do arquivo de estado.
      if (current.size >= FOG_MAX_TOTAL_CELLS) {
        break;
      }

      current.set(key, cell);
    }
  }

  if (op === 'reveal') {
    for (const cell of cells) {
      current.delete(`${cell.x},${cell.y}`);
    }
  }

  state.fog.cells = Array.from(current.values());

  return true;
}

// ---------- COMBATE ----------
const spdOf = s =>
  Number(
    s &&
    s.data &&
    s.data.attributes &&
    s.data.attributes[3] &&
    s.data.attributes[3].valor
  ) || 0;

const sayAll = msg => broadcast({ t: 'log', msg });

const sortEntries = () =>
  state.combat.entries.sort(
    (a, b) =>
      (b.init ?? -1e9) - (a.init ?? -1e9) ||
      b.spd - a.spd
  );

function syncEntries() {
  const c = state.combat;
  const curId = c.entries[c.cur] && c.entries[c.cur].id;

  c.entries = c.entries.filter(e =>
    state.sheets.some(s => s.id === e.id && s.onMap)
  );

  for (const s of state.sheets) {
    if (
      s.onMap &&
      !c.entries.some(e => e.id === s.id)
    ) {
      c.entries.push({
        id: s.id,
        roll: null,
        init: null,
        spd: spdOf(s),
        std: false,
        mov: false
      });
    }
  }

  c.effects = c.effects.filter(f =>
    state.sheets.some(s => s.id === f.sheetId)
  );

  sortEntries();

  const i = c.entries.findIndex(e => e.id === curId);

  c.cur = i >= 0
    ? i
    : Math.min(c.cur, Math.max(0, c.entries.length - 1));
}

function rollEntry(e) {
  const s = state.sheets.find(x => x.id === e.id);
  if (!s) return;

  e.spd = spdOf(s);
  e.roll = d(10);
  e.init = e.spd + e.roll;

  sayAll(
    `🎲 <b>${s.name.replace(/[<>]/g, '')}</b> iniciativa: ` +
    `VEL ${e.spd} + d10 [${e.roll}] = <b>${e.init}</b>`
  );
}

function tickEffects() {
  const c = state.combat;

  c.effects.forEach(f => f.timer--);

  const gone = c.effects.filter(f => f.timer <= 0);

  c.effects = c.effects.filter(f => f.timer > 0);
  c.ticked = true;

  sayAll(
    '⏳ Fase de Status: timers reduzidos em 1.' +
    gone.map(f => {
      const s = state.sheets.find(x => x.id === f.sheetId);

      return ` <i>${f.name.replace(/[<>]/g, '')}</i> ` +
        `(${s ? s.name.replace(/[<>]/g, '') : '?'}) terminou.`;
    }).join('')
  );
}

function handleCombat(m, user) {
  const c = state.combat;
  const { gm, name } = user;

  const ownerOf = id => {
    const s = state.sheets.find(x => x.id === id);
    return !!s && (gm || s.owner === name);
  };

  const ent = () => c.entries.find(e => e.id === m.id);

  const resetActs = e => {
    if (e) {
      e.std = false;
      e.mov = false;
    }
  };

  const needsGm = [
    'cb_start',
    'cb_end',
    'cb_init',
    'cb_phase',
    'cb_prev',
    'cb_tick'
  ];

  if (needsGm.includes(m.t) && !gm) return;

  if (m.t !== 'cb_start' && m.t !== 'cb_end' && !c.active) {
    return;
  }

  switch (m.t) {
    case 'cb_start':
      if (c.active) return;

      Object.assign(c, {
        active: true,
        round: 1,
        phase: 'initiative',
        entries: [],
        cur: 0,
        effects: [],
        ticked: false
      });

      syncEntries();
      sayAll('⚔ <b>Combate iniciado!</b> Rodada 1 — Fase de Iniciativa.');
      break;

    case 'cb_end':
      Object.assign(c, {
        active: false,
        round: 0,
        phase: 'idle',
        entries: [],
        cur: 0,
        effects: [],
        ticked: false
      });

      sayAll('🏁 Combate encerrado.');
      break;

    case 'cb_roll':
      if (c.phase !== 'initiative') return;

      if (m.all && gm) {
        c.entries
          .filter(e => e.init === null)
          .forEach(rollEntry);
      } else {
        const e = ent();

        if (e && ownerOf(e.id)) rollEntry(e);
      }

      sortEntries();
      break;

    case 'cb_init': {
      const e = ent();

      if (!e) return;

      e.init = num(m.v, e.init ?? 0);

      if (e.roll === null) e.roll = 0;

      sortEntries();
      break;
    }

    case 'cb_phase':
      if (c.phase === 'initiative') {
        c.entries
          .filter(e => e.init === null)
          .forEach(rollEntry);

        sortEntries();
        c.cur = 0;
        c.entries.forEach(resetActs);
        c.phase = 'action';

        sayAll(`▶ Rodada ${c.round} — <b>Fase de Ação</b>.`);

      } else if (c.phase === 'action') {
        c.phase = 'status';
        c.ticked = false;

        sayAll(`▶ Rodada ${c.round} — <b>Fase de Status</b>.`);

      } else if (c.phase === 'status') {
        if (!c.ticked) tickEffects();

        c.round++;
        c.phase = 'initiative';
        c.ticked = false;
        c.cur = 0;

        c.entries.forEach(e => {
          e.roll = null;
          e.init = null;
          resetActs(e);
        });

        syncEntries();

        sayAll(`🔁 <b>Rodada ${c.round}</b> — Fase de Iniciativa.`);
      }

      break;

    case 'cb_next': {
      if (c.phase !== 'action') return;

      const cur = c.entries[c.cur];

      if (!cur || !ownerOf(cur.id)) return;

      if (c.cur + 1 >= c.entries.length) {
        c.phase = 'status';
        c.ticked = false;

        sayAll(`▶ Rodada ${c.round} — <b>Fase de Status</b>.`);
      } else {
        c.cur++;
        resetActs(c.entries[c.cur]);
      }

      break;
    }

    case 'cb_prev':
      if (c.phase === 'action' && c.cur > 0) {
        c.cur--;
        resetActs(c.entries[c.cur]);
      }
      break;

    case 'cb_act': {
      const e = ent();

      if (
        e &&
        ownerOf(e.id) &&
        ['std', 'mov'].includes(m.k)
      ) {
        e[m.k] = !!m.v;
      }

      break;
    }

    case 'cb_tick':
      tickEffects();
      break;

    case 'cb_effAdd': {
      if (
        !c.entries.some(e => e.id === m.sheetId) ||
        c.effects.length >= 200
      ) {
        return;
      }

      const nm = String(m.name || '').trim().slice(0, 40);

      if (!nm) return;

      c.effects.push({
        uid: c.nextEff++,
        sheetId: m.sheetId,
        name: nm,
        kind: m.kind === 'buff' ? 'buff' : 'debuff',
        timer: Math.min(99, Math.max(1, m.timer | 0 || 4)),
        by: name
      });

      break;
    }

    case 'cb_effSet':
    case 'cb_effDel': {
      const f = c.effects.find(x => x.uid === m.uid);

      if (!f || !(gm || ownerOf(f.sheetId) || f.by === name)) {
        return;
      }

      if (m.t === 'cb_effDel') {
        c.effects = c.effects.filter(x => x !== f);
      } else {
        f.timer = Math.min(99, m.timer | 0);

        if (f.timer <= 0) {
          c.effects = c.effects.filter(x => x !== f);
        }
      }

      break;
    }

    default:
      return;
  }

  return true;
}

// ---------- CONEXÕES ----------
wss.on('connection', ws => {
  ws.on('message', raw => {
    let m;

    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }

    // Entrada na mesa.
    if (m.t === 'join') {
      const gm = m.role === 'gm';

      if (gm && m.pass !== GM_PASS) {
        return send(ws, {
          t: 'error',
          msg: 'Senha do mestre incorreta.'
        });
      }

      ws.user = {
        name: String(m.name || 'Jogador').slice(0, 20),
        gm
      };

      send(ws, { t: 'joined', user: ws.user });
      send(ws, { t: 'mapimg', src: mapSrc });
      send(ws, { t: 'state', state });

      return broadcast({
        t: 'log',
        msg: `${ws.user.name} entrou${gm ? ' (Mestre)' : ''}.`
      });
    }

    if (!ws.user) return;

    const { gm, name } = ws.user;

    const sh = () =>
      state.sheets.find(s => s.id === m.id);

    const canEdit = s =>
      s && (gm || s.owner === name);

    // Mensagens de combate.
    if (
      typeof m.t === 'string' &&
      m.t.startsWith('cb_')
    ) {
      if (handleCombat(m, ws.user)) sync();
      return;
    }

    switch (m.t) {
      // ---------- BACKUP / RESTAURAÇÃO DE FICHAS ----------
      case 'importSheets': {
        if (!gm) return;
        const backup = m.backup;
        if (
          !backup ||
          backup.format !== 'vtt-ffrpg-sheets' ||
          !Array.isArray(backup.sheets) ||
          backup.sheets.length > 500 ||
          JSON.stringify(backup).length > 12 * 1024 * 1024
        ) return send(ws, { t: 'error', msg: 'Backup inválido ou grande demais.' });

        const validSheets = backup.sheets.every(sheet =>
          sheet &&
          Number.isSafeInteger(sheet.id) && sheet.id > 0 &&
          typeof sheet.name === 'string' &&
          typeof sheet.owner === 'string' &&
          sheet.data && typeof sheet.data === 'object' && !Array.isArray(sheet.data)
        );
        const ids = backup.sheets.map(sheet => sheet.id);
        if (!validSheets || new Set(ids).size !== ids.length) {
          return send(ws, { t: 'error', msg: 'O backup contém fichas inválidas ou IDs repetidos.' });
        }

        // Restaura somente as fichas. Mapa, grade e névoa atuais não são alterados.
        state.sheets = backup.sheets.map(sheet => ({
          ...sheet,
          onMap: !!sheet.onMap,
          data: sheet.data || {}
        }));
        const highestId = ids.length ? Math.max(...ids) : 0;
        state.nextId = Math.max(highestId + 1, Number(backup.nextId) || 1);
        state.order = state.order.filter(id => state.sheets.some(sheet => sheet.id === id));
        state.combat = {
          active: false, round: 0, phase: 'idle', entries: [], cur: 0,
          effects: [], nextEff: 1, ticked: false
        };
        break;
      }

      // ---------- FOG OF WAR ----------
      case 'fog':
        if (!handleFog(m, ws.user)) return;
        break;

      // ---------- FICHAS ----------
      case 'newSheet':
        state.sheets.push({
          id: state.nextId++,
          owner: name,
          name: 'Novo personagem',
          img: '',
          color: '#4a90e2',
          hp: 30,
          maxHp: 30,
          mp: 10,
          maxMp: 10,
          xp: 0,
          maxXp: 100,
          data: {},
          onMap: false,
          x: 1,
          y: 1
        });
        break;

      case 'set': {
        const s = sh();

        if (!canEdit(s)) return;

        if (TOP_TEXT.includes(m.k)) {
          s[m.k] = String(m.v).slice(0, 60);
        } else if (TOP_NUM.includes(m.k)) {
          s[m.k] = num(m.v);
        } else if (
          m.k === 'img' &&
          typeof m.v === 'string' &&
          m.v.length < 300000
        ) {
          s.img = m.v;
        } else if (m.k === 'owner' && gm) {
          s.owner = String(m.v).slice(0, 20);
        }

        break;
      }

      case 'data': {
        const s = sh();

        if (!canEdit(s) || !/^[\w-]{1,40}$/.test(m.k)) {
          return;
        }

        if (
          typeof m.v === 'number' &&
          Number.isFinite(m.v)
        ) {
          s.data[m.k] = m.v;
        } else if (typeof m.v === 'string') {
          s.data[m.k] = m.v.slice(0, 3000);
        } else if (
          isRepeatableData(m.v) &&
          JSON.stringify(m.v).length <= 100000
        ) {
          s.data[m.k] = m.v;
        }

        break;
      }

      case 'share': {
        const s = sh();

        const sharedFields = {
          weapons: { key: 'ability', label: 'Arma' },
          armor: { key: 'ability', label: 'Armadura' },
          abilities: { key: 'effect', label: 'Habilidade/Magia' }
        };

        const field = sharedFields[m.tableKey];

        if (
          !canEdit(s) ||
          !field ||
          field.key !== m.columnKey ||
          !Number.isInteger(m.rowIndex) ||
          m.rowIndex < 0 ||
          typeof m.text !== 'string' ||
          !m.text.trim()
        ) {
          return;
        }

        const rows = Array.isArray(s.data[m.tableKey])
          ? s.data[m.tableKey]
          : [];

        const fixedCount =
          m.tableKey === 'weapons' ? 2 :
          m.tableKey === 'armor' ? 5 : 0;

        const row = rows[m.rowIndex] || {};

        if (m.rowIndex >= (fixedCount || rows.length)) {
          return;
        }

        const slots = {
          weapons: ['Mão', 'Mão Inábil'],
          armor: [
            'Cabeça',
            'Corpo',
            'Mãos',
            'Acessório 1',
            'Acessório 2'
          ]
        };

        const slot = slots[m.tableKey]
          ? slots[m.tableKey][m.rowIndex]
          : '';

        const item = String(
          row.name || `${field.label} (${slot})`
        ).slice(0, 80);

        return broadcast({
          t: 'chat',
          sender: name,
          character: String(s.name || 'Personagem').slice(0, 60),
          item,
          text: m.text.slice(0, 3000)
        });
      }

      case 'delSheet': {
        const s = sh();

        if (!canEdit(s)) return;

        state.sheets = state.sheets.filter(x => x !== s);
        state.order = state.order.filter(i => i !== s.id);

        break;
      }

      case 'toggleMap': {
        const s = sh();

        if (!canEdit(s)) return;

        s.onMap = !s.onMap;

        state.order = state.order.filter(i => i !== s.id);

        if (s.onMap) {
          state.order.push(s.id);
        }

        break;
      }

      case 'move': {
        const s = sh();

        if (!canEdit(s) || !s.onMap) return;

        s.x = m.x | 0;
        s.y = m.y | 0;

        break;
      }

      // ---------- GRADE ----------
      case 'grid':
        if (gm) {
          for (const k of ['size', 'ox', 'oy', 'opacity']) {
            if (k in m) {
              state.grid[k] = num(m[k], state.grid[k]);
            }
          }

          if ('show' in m) {
            state.grid.show = !!m.show;
          }

          if (typeof m.color === 'string') {
            state.grid.color = m.color.slice(0, 9);
          }

          state.grid.size = Math.max(8, state.grid.size);
        }

        break;

      // ---------- MAPA ----------
      case 'map':
        if (gm) {
          for (const k of ['scale', 'ox', 'oy']) {
            if (k in m) {
              state.map[k] = num(m[k], state.map[k]);
            }
          }

          state.map.scale = Math.max(0.01, state.map.scale);
        }

        break;

      case 'mapimg':
        if (gm && typeof m.src === 'string') {
          mapSrc = m.src;

          state.map = {
            has: !!m.src,
            scale: 1,
            ox: 0,
            oy: 0
          };

          fs.writeFile(MAPFILE, mapSrc, () => {});

          broadcast({
            t: 'mapimg',
            src: mapSrc
          });
        }

        break;

      // ---------- TURNOS ----------
      case 'turn':
        if (gm && state.order.length) {
          state.turn = (
            state.turn +
            (m.dir || 1) +
            state.order.length
          ) % state.order.length;
        }

        break;

      case 'reorder':
        if (gm) {
          const i = state.order.indexOf(m.id);
          const j = i + (m.dir || 0);

          if (
            i >= 0 &&
            j >= 0 &&
            j < state.order.length
          ) {
            [
              state.order[i],
              state.order[j]
            ] = [
              state.order[j],
              state.order[i]
            ];
          }
        }

        break;

      // ---------- DADOS ----------
      case 'roll': {
        const qty = Math.min(20, m.qty | 0);
        const sides = Math.min(1000, m.sides | 0);
        const mod = m.mod | 0;

        if (qty < 1 || sides < 2) return;

        const rolls = Array.from(
          { length: qty },
          () => d(sides)
        );

        const total =
          rolls.reduce((a, b) => a + b, 0) + mod;

        const label = String(m.label || '')
          .replace(/[<>]/g, '');

        return broadcast({
          t: 'log',
          msg:
            `<b>${name}</b> ${label} ` +
            `${qty}d${sides}` +
            `${mod ? (mod > 0 ? '+' : '') + mod : ''}: ` +
            `[${rolls}] = <b>${total}</b>`
        });
      }

      default:
        return;
    }

    if (state.order.length) {
      state.turn %= state.order.length;
    } else {
      state.turn = 0;
    }

    if (state.combat.active) {
      syncEntries();
    }

    // Envia o estado atualizado para todos e salva no data.json.
    sync();
  });
});

// ---------- INICIAR SERVIDOR ----------
server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `VTT rodando em http://localhost:${PORT} ` +
    `(senha do mestre: ${GM_PASS})`
  );
});
