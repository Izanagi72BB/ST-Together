// ST-Together relay plugin (host side).
// Owns the WebSocket session: token auth, turn referee, message routing,
// and the optional trycloudflare quick tunnel for remote guests.
// The UI extension (both roles) connects here as a WS client; only the
// host role can execute LLM actions, so guest intents are forwarded to
// the host client as 'exec' frames.

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

const DEFAULT_PORT = 5138;
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

let wss = null;
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
    return wss ? [...wss.clients].filter(c => c.meta?.authed) : [];
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
    if (commandExistsSync('cloudflared')) return 'cloudflared';
    if (fs.existsSync(localCloudflared)) return localCloudflared;
    const asset = cloudflaredAssetName();
    if (!asset) {
        throw new Error('cloudflared is not installed. Install it (on macOS: brew install cloudflared) and restart SillyTavern.');
    }
    console.log('[ST-Together] cloudflared not found, downloading to plugin folder ...');
    const response = await fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`, { redirect: 'follow' });
    if (!response.ok) throw new Error(`cloudflared download failed: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(localCloudflared, buffer, { mode: 0o755 });
    console.log(`[ST-Together] cloudflared downloaded (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
    return localCloudflared;
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
        send(ws, { t: 'welcome', role, turn: session.turnHolder, autoPass: session.autoPass });
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
                if (session.turnHolder !== 'guest') {
                    return send(ws, { t: 'error', code: 'not-your-turn' });
                }
                const h = hostClient();
                if (!h) return send(ws, { t: 'error', code: 'no-host' });
                // Host executes it (inject + generate); other guests just render it.
                send(h, { ...frame, t: 'exec', kind: 'message' });
                for (const g of guestClients()) {
                    if (g !== ws) send(g, frame);
                }
            } else {
                // Host wrote through the native ST flow; relay to guests.
                for (const g of guestClients()) send(g, frame);
            }
            return;
        }
        case 'action': {
            const kind = msg.kind;
            if (!['continue', 'botreply', 'pass'].includes(kind)) return;
            if (session.turnHolder !== meta.role) {
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
        case 'gen.start':
        case 'gen.token':
        case 'gen.end':
        case 'gen.abort': {
            if (meta.role !== 'host') return;
            for (const g of guestClients()) send(g, msg);
            if (msg.t === 'gen.end' && session.autoPass) {
                setTurn(otherRole(session.turnHolder), 'auto');
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

function startServer(port) {
    return new Promise((resolve, reject) => {
        const server = new WebSocketServer({ host: '127.0.0.1', port });
        server.on('listening', () => resolve(server));
        server.on('error', reject);
        server.on('connection', (ws) => {
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
                if (ws.meta.authed) {
                    broadcast({ t: 'peer', name: ws.meta.name, role: ws.meta.role, online: false }, ws);
                }
            });
            setTimeout(() => {
                if (!ws.meta.authed && ws.readyState === 1) ws.close(4008, 'auth timeout');
            }, AUTH_TIMEOUT_MS);
        });
    });
}

function stopSession() {
    if (session?.heartbeat) clearInterval(session.heartbeat);
    if (session?.tunnel?.proc) {
        session.tunnel.proc.kill();
        session.tunnel = null;
    }
    if (wss) {
        for (const c of wss.clients) c.close(1001, 'session ended');
        wss.close();
    }
    wss = null;
    session = null;
}

export async function init(router) {
    router.use(express.json());

    router.post('/start', async (req, res) => {
        try {
            if (session) {
                return res.status(409).json({ error: 'Session already active', port: session.port });
            }
            const port = Number(req.body?.port) || DEFAULT_PORT;
            const autoPass = !!req.body?.autoPass;
            const wantTunnel = !!req.body?.tunnel;
            const token = makeToken();
            wss = await startServer(port);
            session = { token, port, autoPass, turnHolder: 'host', pendingSnapshots: new Map(), tunnel: null };
            session.heartbeat = setInterval(() => {
                if (!wss) return;
                for (const c of wss.clients) {
                    if (!c.meta.alive) { c.terminate(); continue; }
                    c.meta.alive = false;
                    c.ping();
                }
            }, HEARTBEAT_MS);

            if (wantTunnel) {
                try {
                    const bin = await findCloudflared();
                    session.tunnel = await startTunnel(bin, port);
                    console.log(`[ST-Together] tunnel up: ${session.tunnel.url}, waiting for DNS ...`);
                    const dnsReady = await waitForTunnelDns(session.tunnel.url);
                    if (!dnsReady) throw new Error('tunnel DNS did not propagate within 90s');
                    console.log('[ST-Together] tunnel DNS is live, invite is shareable');
                } catch (error) {
                    stopSession();
                    return res.status(500).json({ error: `Tunnel failed: ${error?.message ?? error}` });
                }
            }

            console.log(`[ST-Together] session listening on 127.0.0.1:${port}`);
            res.json({
                ok: true,
                port,
                token,
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

    router.get('/status', (_req, res) => {
        if (!session) return res.json({ active: false });
        res.json({
            active: true,
            port: session.port,
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
