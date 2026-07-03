// ST-Together relay plugin (host side).
// Serves a WebSocket on SillyTavern's OWN http server at
// /api/plugins/st-together/ws, so it travels through the same origin, port,
// and TLS as the rest of SillyTavern (works behind Cloudflare / a reverse
// proxy). Owns token auth, the turn referee, message routing, and an
// optional trycloudflare tunnel for hosts whose ST is not publicly exposed.
// Only the host role can execute LLM actions, so guest intents are forwarded
// to the host client as 'exec' frames.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { spawn } from 'node:child_process';
import express from 'express';
import { WebSocketServer } from 'ws';
import { sync as commandExistsSync } from 'command-exists';

export const info = {
    id: 'st-together',
    name: 'ST-Together',
    description: 'Multiplayer relay: session tokens, turn referee, message sync between ST instances.',
};

const VERSION = '0.5.0';
const WS_PATH = '/api/plugins/st-together/ws';
const MAX_GUESTS = 3;
const AUTH_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 30000;
const TUNNEL_TIMEOUT_MS = 45000;

const moduleDir = path.dirname(url.fileURLToPath(import.meta.url));
const localCloudflared = path.join(moduleDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');

// Standalone binaries only; macOS releases ship as archives, so Mac hosts
// need a system install (brew install cloudflared) instead.
function cloudflaredAssetName() {
    if (process.platform === 'win32') return 'cloudflared-windows-amd64.exe';
    if (process.platform === 'linux') return process.arch === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64';
    return null;
}

// One persistent WS server in "noServer" mode; upgrades are fed to it by the
// handler we attach to ST's http server. Sessions come and go; this does not.
const wss = new WebSocketServer({ noServer: true });
let upgradeAttached = false;
let httpServer = null;
let session = null;

function makeToken() {
    return crypto.randomBytes(9).toString('base64url');
}

function send(ws, obj) {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(obj));
    }
}

function authedClients() {
    return [...wss.clients].filter(c => c.meta?.authed);
}

function hostClient() {
    return authedClients().find(c => c.meta.role === 'host') ?? null;
}

function guestClients() {
    return authedClients().filter(c => c.meta.role === 'guest');
}

function broadcast(obj, except = null) {
    for (const client of authedClients()) {
        if (client !== except) send(client, obj);
    }
}

function otherRole(role) {
    return role === 'host' ? 'guest' : 'host';
}

function setTurn(holder, reason) {
    session.turnHolder = holder;
    broadcast({ t: 'turn', holder, reason });
}

// ------------------------------------------------------------------ tunnel

async function findCloudflared() {
    // Prefer our own freshly-downloaded binary over a system cloudflared:
    // older system installs silently drop WebSocket upgrades in quick-tunnel
    // (--url) mode, which breaks guest connections in a way that looks like a
    // 404. A current binary forwards WebSockets correctly.
    if (fs.existsSync(localCloudflared)) return localCloudflared;
    const asset = cloudflaredAssetName();
    if (asset) {
        try {
            console.log('[ST-Together] downloading a current cloudflared to the plugin folder ...');
            const response = await fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`, { redirect: 'follow' });
            if (response.ok) {
                const buffer = Buffer.from(await response.arrayBuffer());
                fs.writeFileSync(localCloudflared, buffer, { mode: 0o755 });
                console.log(`[ST-Together] cloudflared downloaded (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
                return localCloudflared;
            }
            console.error(`[ST-Together] cloudflared download failed: HTTP ${response.status}`);
        } catch (error) {
            console.error('[ST-Together] cloudflared download failed:', error?.message ?? error);
        }
    }
    // Fall back to a system cloudflared only if we could not fetch our own.
    if (commandExistsSync('cloudflared')) {
        console.warn('[ST-Together] using system cloudflared; if guests get a 404, it is too old for quick-tunnel WebSockets — update it.');
        return 'cloudflared';
    }
    throw new Error('cloudflared is not available and could not be downloaded. Install it (on macOS: brew install cloudflared) and restart SillyTavern.');
}

function startTunnel(bin, port) {
    return new Promise((resolve, reject) => {
        const proc = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) { settled = true; proc.kill(); reject(new Error('tunnel start timed out')); }
        }, TUNNEL_TIMEOUT_MS);
        const onData = (chunk) => {
            output += chunk.toString();
            const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
            if (match && !settled) {
                settled = true;
                clearTimeout(timer);
                resolve({ proc, url: match[0] });
            }
        };
        proc.stdout.on('data', onData);
        proc.stderr.on('data', onData);
        proc.on('exit', (code) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(new Error(`cloudflared exited with code ${code}`));
            } else if (session?.tunnel?.proc === proc) {
                console.error('[ST-Together] tunnel process died unexpectedly');
                session.tunnel = null;
                broadcast({ t: 'error', code: 'tunnel-down', msg: 'The Cloudflare tunnel dropped. Remote guests will disconnect.' });
            }
        });
    });
}

// Quick-tunnel DNS records take ~30s to go live. Handing out the invite
// early would make clients query too soon and negative-cache the miss,
// so wait until Cloudflare's own DoH endpoint confirms the record exists.
async function waitForTunnelDns(tunnelUrl) {
    const hostname = new URL(tunnelUrl).hostname;
    for (let attempt = 0; attempt < 30; attempt++) {
        try {
            const response = await fetch(
                `https://cloudflare-dns.com/dns-query?name=${hostname}&type=A`,
                { headers: { accept: 'application/dns-json' } },
            );
            const data = await response.json();
            if (data.Answer?.some(a => a.type === 1)) return true;
        } catch { /* transient; keep polling */ }
        await new Promise(r => setTimeout(r, 3000));
    }
    return false;
}

// ------------------------------------------------------------------ frames

function onFrame(ws, raw) {
    let msg;
    try {
        msg = JSON.parse(raw);
    } catch {
        return send(ws, { t: 'error', code: 'bad-json' });
    }
    const meta = ws.meta;

    if (!session) return ws.close(4004, 'no active session');

    if (!meta.authed) {
        if (msg.t !== 'hello') return ws.close(4001, 'hello required');
        if (typeof msg.token !== 'string' || msg.token !== session.token) {
            send(ws, { t: 'error', code: 'bad-token' });
            return ws.close(4003, 'bad token');
        }
        const role = msg.role === 'host' ? 'host' : 'guest';
        if (role === 'host' && hostClient()) {
            send(ws, { t: 'error', code: 'host-taken' });
            return ws.close(4009, 'host taken');
        }
        if (role === 'guest' && guestClients().length >= MAX_GUESTS) {
            send(ws, { t: 'error', code: 'room-full' });
            return ws.close(4010, 'room full');
        }
        meta.authed = true;
        meta.role = role;
        meta.name = String(msg.name || (role === 'host' ? 'Host' : 'Guest')).slice(0, 64);
        send(ws, { t: 'welcome', role, turn: session.turnHolder, autoPass: session.autoPass, paused: session.paused, mode: session.mode });
        broadcast({ t: 'peer', name: meta.name, role, online: true }, ws);
        if (role === 'guest') {
            const h = hostClient();
            if (h) {
                const reqId = crypto.randomUUID();
                session.pendingSnapshots.set(reqId, ws);
                send(h, { t: 'snapshot.req', reqId });
            } else {
                send(ws, { t: 'error', code: 'no-host', msg: 'Host is not connected yet.' });
            }
        }
        return;
    }

    switch (msg.t) {
        case 'snapshot': {
            if (meta.role !== 'host') return;
            const payload = {
                t: 'snapshot',
                chatName: msg.chatName,
                messages: Array.isArray(msg.messages) ? msg.messages : [],
                botAvatar: msg.botAvatar ?? null,
                fresh: !!msg.fresh,
                turn: session.turnHolder,
            };
            if (msg.reqId) {
                // Answer to a join request; route to the guest that asked.
                const target = session.pendingSnapshots.get(msg.reqId);
                session.pendingSnapshots.delete(msg.reqId);
                if (target) send(target, payload);
            } else {
                // Host-initiated resync (edit/delete/swipe); everyone reconciles.
                for (const g of guestClients()) send(g, payload);
            }
            return;
        }
        case 'msg.user': {
            const frame = {
                t: 'msg.user',
                uid: String(msg.uid ?? ''),
                name: meta.role === 'host' ? String(msg.name ?? meta.name) : meta.name,
                text: String(msg.text ?? ''),
                sendDate: msg.sendDate,
            };
            if (meta.role === 'guest') {
                if (session.paused) {
                    return send(ws, { t: 'error', code: 'host-away' });
                }
                // Freeform mode has no turn lock; other modes enforce it.
                if (session.mode !== 'free' && session.turnHolder !== 'guest') {
                    return send(ws, { t: 'error', code: 'not-your-turn' });
                }
                const h = hostClient();
                if (!h) return send(ws, { t: 'error', code: 'no-host' });
                // Host records it (and decides whether the AI replies, per mode);
                // other guests just render it.
                send(h, { ...frame, t: 'exec', kind: 'message' });
                for (const g of guestClients()) {
                    if (g !== ws) send(g, frame);
                }
            } else {
                // Host wrote it; relay to guests.
                for (const g of guestClients()) send(g, frame);
            }
            return;
        }
        case 'action': {
            const kind = msg.kind;
            if (!['continue', 'botreply', 'pass'].includes(kind)) return;
            if (meta.role === 'guest' && session.paused) {
                return send(ws, { t: 'error', code: 'host-away' });
            }
            if (session.mode !== 'free' && session.turnHolder !== meta.role) {
                return send(ws, { t: 'error', code: 'not-your-turn' });
            }
            if (kind === 'pass') {
                return setTurn(otherRole(meta.role), 'pass');
            }
            const h = hostClient();
            if (!h) return send(ws, { t: 'error', code: 'no-host' });
            send(h, { t: 'exec', kind });
            return;
        }
        case 'setturn': {
            // Host drives turn changes (per the active mode).
            if (meta.role !== 'host') return;
            return setTurn(msg.holder === 'guest' ? 'guest' : 'host', 'host');
        }
        case 'mode': {
            if (meta.role !== 'host') return;
            session.mode = ['reply', 'round', 'free'].includes(msg.mode) ? msg.mode : 'reply';
            broadcast({ t: 'mode', mode: session.mode });
            return;
        }
        case 'gen.start':
        case 'gen.token':
        case 'gen.end':
        case 'gen.abort': {
            // Host relays generation to guests. Turn changes are host-driven
            // (via setturn), so the server no longer auto-passes here.
            if (meta.role !== 'host') return;
            for (const g of guestClients()) send(g, msg);
            return;
        }
        case 'share.paused': {
            // Host stepped out of (or back into) the shared chat.
            if (meta.role !== 'host') return;
            session.paused = !!msg.paused;
            for (const g of guestClients()) send(g, { t: 'share.paused', paused: session.paused });
            return;
        }
        case 'snapshot.get': {
            // Guest asking for a fresh snapshot (mirror moved or resumed).
            if (meta.role !== 'guest') return;
            const h = hostClient();
            if (!h) return send(ws, { t: 'error', code: 'no-host' });
            const reqId = crypto.randomUUID();
            session.pendingSnapshots.set(reqId, ws);
            send(h, { t: 'snapshot.req', reqId });
            return;
        }
        case 'vote': {
            // Cooperative vote: one player proposes an action ('swipe' to
            // regenerate, or 'summon' to bring the AI in), another must agree,
            // then the host runs it.
            if (msg.kind === 'request') {
                const forWhat = ['swipe', 'summon'].includes(msg.for) ? msg.for : 'swipe';
                const others = authedClients().filter(c => c !== ws);
                if (!others.length) return send(ws, { t: 'error', code: 'no-peer', msg: 'No one else is here to vote.' });
                session.vote = { byWs: ws, for: forWhat };
                for (const c of others) send(c, { t: 'vote', kind: 'request', name: meta.name, for: forWhat });
                return;
            }
            if (!session.vote) return;
            if (msg.kind === 'agree') {
                if (ws === session.vote.byWs) return; // can't agree with yourself
                const forWhat = session.vote.for;
                session.vote = null;
                broadcast({ t: 'vote', kind: 'passed', for: forWhat });
                const h = hostClient();
                if (h) send(h, { t: 'exec', kind: forWhat === 'summon' ? 'botreply' : 'swipe' });
                return;
            }
            if (msg.kind === 'disagree' || msg.kind === 'cancel') {
                session.vote = null;
                broadcast({ t: 'vote', kind: 'failed', name: meta.name });
                return;
            }
            return;
        }
        case 'persona': {
            // Persona identity (name, optional description, optional avatar).
            // Guests announce to the host (for the AI + avatars); the host
            // announces to guests (so they can show the host's avatar).
            const payload = {
                t: 'persona',
                name: String(msg.name ?? meta.name).slice(0, 64),
                description: String(msg.description ?? '').slice(0, 2000),
                avatar: msg.avatar && typeof msg.avatar === 'object' ? msg.avatar : null,
            };
            if (meta.role === 'guest') {
                const h = hostClient();
                if (h) send(h, payload);
            } else {
                for (const g of guestClients()) send(g, payload);
            }
            return;
        }
        case 'typing': {
            broadcast({ t: 'typing', name: meta.name, role: meta.role, active: !!msg.active }, ws);
            return;
        }
        case 'turn.get': {
            return send(ws, { t: 'turn', holder: session.turnHolder });
        }
        default:
            return;
    }
}

wss.on('connection', (ws) => {
    if (!session) return ws.close(4004, 'no active session');
    ws.meta = { authed: false, role: null, name: null, alive: true };
    ws.on('pong', () => { ws.meta.alive = true; });
    ws.on('message', (raw) => {
        try {
            onFrame(ws, raw);
        } catch (error) {
            console.error('[ST-Together] frame error:', error);
        }
    });
    ws.on('close', () => {
        if (session?.vote?.byWs === ws) {
            session.vote = null;
            broadcast({ t: 'vote', kind: 'failed', name: ws.meta.name });
        }
        if (ws.meta.authed) {
            broadcast({ t: 'peer', name: ws.meta.name, role: ws.meta.role, online: false }, ws);
        }
    });
    setTimeout(() => {
        if (!ws.meta.authed && ws.readyState === 1) ws.close(4008, 'auth timeout');
    }, AUTH_TIMEOUT_MS);
});

// Attach our upgrade handler to ST's own http server exactly once. We only
// claim upgrades to WS_PATH and leave every other path untouched, so this
// coexists with anything else that might handle upgrades.
function attachUpgrade(server) {
    if (upgradeAttached || !server) return;
    upgradeAttached = true;
    httpServer = server;
    server.on('upgrade', (request, socket, head) => {
        let pathname;
        try {
            pathname = new URL(request.url, 'http://localhost').pathname;
        } catch {
            return;
        }
        // Diagnostic: proves whether a WS upgrade actually reaches ST (vs being
        // stripped upstream by a reverse proxy, which turns it into a plain GET).
        console.log(`[ST-Together] upgrade received: path=${pathname} host=${request.headers.host} upgrade=${request.headers.upgrade}`);
        if (pathname !== WS_PATH) return;
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    });
}

function stopSession() {
    if (session?.heartbeat) clearInterval(session.heartbeat);
    if (session?.tunnel?.proc) {
        session.tunnel.proc.kill();
        session.tunnel = null;
    }
    for (const c of wss.clients) c.close(1001, 'session ended');
    session = null;
}

export async function init(router) {
    router.use(express.json());
    // Grab ST's http server from the first request so we can serve the WS on it.
    router.use((req, _res, next) => {
        attachUpgrade(req.socket.server);
        next();
    });

    router.post('/start', async (req, res) => {
        try {
            if (session) {
                return res.status(409).json({ error: 'Session already active' });
            }
            const autoPass = !!req.body?.autoPass;
            const wantTunnel = !!req.body?.tunnel;
            const mode = ['reply', 'round', 'free'].includes(req.body?.mode) ? req.body.mode : 'reply';
            const token = makeToken();
            session = { token, autoPass, mode, turnHolder: 'host', paused: false, pendingSnapshots: new Map(), tunnel: null };
            session.heartbeat = setInterval(() => {
                for (const c of wss.clients) {
                    if (!c.meta?.alive) { c.terminate(); continue; }
                    c.meta.alive = false;
                    c.ping();
                }
            }, HEARTBEAT_MS);

            if (wantTunnel) {
                try {
                    const stPort = httpServer?.address()?.port;
                    if (!stPort) throw new Error('could not determine SillyTavern port');
                    console.log(`[ST-Together] tunneling to SillyTavern at http://127.0.0.1:${stPort}`);
                    const bin = await findCloudflared();
                    session.tunnel = await startTunnel(bin, stPort);
                    console.log(`[ST-Together] tunnel up: ${session.tunnel.url}, waiting for DNS ...`);
                    const dnsReady = await waitForTunnelDns(session.tunnel.url);
                    if (!dnsReady) throw new Error('tunnel DNS did not propagate within 90s');
                    console.log('[ST-Together] tunnel DNS is live, invite is shareable');
                } catch (error) {
                    stopSession();
                    return res.status(500).json({ error: `Tunnel failed: ${error?.message ?? error}` });
                }
            }

            console.log('[ST-Together] session started');
            res.json({
                ok: true,
                token,
                wsPath: WS_PATH,
                tunnelUrl: session.tunnel?.url ?? null,
            });
        } catch (error) {
            stopSession();
            res.status(500).json({ error: String(error?.message ?? error) });
        }
    });

    router.post('/stop', (_req, res) => {
        stopSession();
        console.log('[ST-Together] session stopped');
        res.json({ ok: true });
    });

    // Zero-auth version probe: visit this URL in a browser to confirm the
    // server plugin actually updated (the extension's Update button does not
    // touch it; only a full SillyTavern restart git-pulls the plugin).
    router.get('/version', (_req, res) => {
        res.json({ version: VERSION, wsPath: WS_PATH, upgradeAttached });
    });

    router.get('/status', (_req, res) => {
        if (!session) return res.json({ active: false, version: VERSION });
        res.json({
            active: true,
            version: VERSION,
            mode: session.mode,
            turnHolder: session.turnHolder,
            autoPass: session.autoPass,
            tunnelUrl: session.tunnel?.url ?? null,
            clients: authedClients().map(c => ({ role: c.meta.role, name: c.meta.name })),
        });
    });
}

export async function exit() {
    stopSession();
}
