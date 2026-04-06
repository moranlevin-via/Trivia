#!/usr/bin/env node
/**
 * Load test: many Socket.io clients join the same room.
 *
 * Prerequisites:
 *   - Host must have started a game (lobby) so the room code exists.
 *   - npm install (dev: socket.io-client)
 *
 * Usage:
 *   node scripts/load-test-join.js --url https://your-app.up.railway.app --code ABC12 --count 100
 *   node scripts/load-test-join.js --url http://localhost:3000 --code ABC12 --count 100 --keep-open --hold-ms 5000
 *
 * Env (optional): BASE_URL, ROOM_CODE, COUNT, STAGGER_MS, TIMEOUT_MS, HOLD_MS, KEEP_OPEN=1
 */

const { io } = require('socket.io-client');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    url: process.env.BASE_URL || 'http://localhost:3000',
    code: process.env.ROOM_CODE || null,
    count: parseInt(process.env.COUNT || '100', 10),
    staggerMs: parseInt(process.env.STAGGER_MS || '0', 10),
    timeoutMs: parseInt(process.env.TIMEOUT_MS || '120000', 10),
    holdMs: parseInt(process.env.HOLD_MS || '3000', 10),
    keepOpen: process.env.KEEP_OPEN === '1' || process.env.KEEP_OPEN === 'true',
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--url' && args[i + 1]) out.url = args[++i];
    else if (a === '--code' && args[i + 1]) out.code = args[++i].toUpperCase();
    else if (a === '--count' && args[i + 1]) out.count = parseInt(args[++i], 10);
    else if (a === '--stagger-ms' && args[i + 1]) out.staggerMs = parseInt(args[++i], 10);
    else if (a === '--timeout-ms' && args[i + 1]) out.timeoutMs = parseInt(args[++i], 10);
    else if (a === '--hold-ms' && args[i + 1]) out.holdMs = parseInt(args[++i], 10);
    else if (a === '--keep-open') out.keepOpen = true;
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function runOneJoin(url, code, index, timeoutMs, keepSocket) {
  return new Promise((resolve) => {
    const name = `LT${String(index).padStart(4, '0')}`;
    const socket = io(url, {
      transports: ['websocket', 'polling'],
      reconnection: false,
      timeout: Math.min(timeoutMs, 60000),
    });

    const finish = (result) => {
      if (!keepSocket || !result.ok) {
        try {
          socket.removeAllListeners();
          socket.disconnect();
        } catch (_) {}
      }
      resolve({ ...result, socket: keepSocket && result.ok ? socket : null });
    };

    const timer = setTimeout(() => {
      finish({ ok: false, index, name, error: 'timeout' });
    }, timeoutMs);

    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, index, name, error: err.message || 'connect_error' });
    });

    socket.on('connect', () => {
      socket.emit('join-game', { code, name });
    });

    socket.once('joined-game', () => {
      clearTimeout(timer);
      finish({ ok: true, index, name });
    });

    socket.once('join-error', (msg) => {
      clearTimeout(timer);
      finish({ ok: false, index, name, error: String(msg) });
    });
  });
}

async function main() {
  const opts = parseArgs();
  if (!opts.code) {
    console.error('Missing room code. Example:\n  node scripts/load-test-join.js --url https://... --code ABC12 --count 100');
    process.exit(1);
  }
  if (!Number.isFinite(opts.count) || opts.count < 1 || opts.count > 5000) {
    console.error('Invalid --count (use 1..5000)');
    process.exit(1);
  }

  console.log('TriVia load test (join-room)');
  console.log('  url        :', opts.url);
  console.log('  code       :', opts.code);
  console.log('  count      :', opts.count);
  console.log('  stagger-ms :', opts.staggerMs);
  console.log('  keep-open  :', opts.keepOpen);
  console.log('---');

  const started = Date.now();
  const results = [];

  if (opts.keepOpen) {
    const sockets = [];
    if (opts.staggerMs <= 0) {
      const promises = [];
      for (let i = 0; i < opts.count; i++) {
        promises.push(runOneJoin(opts.url, opts.code, i, opts.timeoutMs, true));
      }
      const r = await Promise.all(promises);
      results.push(...r);
      for (const x of r) {
        if (x.socket) sockets.push(x.socket);
      }
    } else {
      for (let i = 0; i < opts.count; i++) {
        const r = await runOneJoin(opts.url, opts.code, i, opts.timeoutMs, true);
        results.push(r);
        if (r.socket) sockets.push(r.socket);
        if (i < opts.count - 1) await sleep(opts.staggerMs);
      }
    }

    const elapsed = Date.now() - started;
    const ok = results.filter((r) => r.ok).length;
    const fail = results.filter((r) => !r.ok);
    console.log('Join phase:');
    console.log('  joined OK :', ok, '/', opts.count);
    console.log('  failed    :', fail.length);
    console.log('  wall time :', `${elapsed} ms`);

    if (fail.length) {
      const byErr = {};
      for (const f of fail) {
        const k = f.error || 'unknown';
        byErr[k] = (byErr[k] || 0) + 1;
      }
      console.log('  failures by reason:', byErr);
    }

    if (sockets.length && opts.holdMs > 0) {
      console.log(`\nKeeping ${sockets.length} sockets open for ${opts.holdMs} ms...`);
      await sleep(opts.holdMs);
    }
    for (const s of sockets) {
      try {
        s.removeAllListeners();
        s.disconnect();
      } catch (_) {}
    }
    console.log('Disconnected all clients.');
    process.exit(fail.length ? 1 : 0);
    return;
  }

  // Default: join then disconnect immediately (measures burst join completion)
  if (opts.staggerMs <= 0) {
    const promises = [];
    for (let i = 0; i < opts.count; i++) {
      promises.push(runOneJoin(opts.url, opts.code, i, opts.timeoutMs, false));
    }
    results.push(...(await Promise.all(promises)));
  } else {
    for (let i = 0; i < opts.count; i++) {
      results.push(await runOneJoin(opts.url, opts.code, i, opts.timeoutMs, false));
      if (i < opts.count - 1) await sleep(opts.staggerMs);
    }
  }

  const elapsed = Date.now() - started;
  const ok = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok);

  console.log('Results:');
  console.log('  joined OK :', ok, '/', opts.count);
  console.log('  failed    :', fail.length);
  console.log('  wall time :', `${elapsed} ms`);
  if (fail.length) {
    const byErr = {};
    for (const f of fail) {
      const k = f.error || 'unknown';
      byErr[k] = (byErr[k] || 0) + 1;
    }
    console.log('  failures by reason:', byErr);
    console.log('  sample:', fail.slice(0, 10));
  }

  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
