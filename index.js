// ST-Together: two SillyTavern instances, one shared chat, fluid turns.
// Host role: relays the authoritative chat through the st-together server
// plugin and executes all LLM actions. Guest role: mirrors the chat and
// sends intents (messages, continue, bot reply, pass) to the host.

const MOD = 'st-together';
const DEFAULT_PORT = 5138;
const TYPING_IDLE_MS = 2500;
const STREAM_THROTTLE_MS = 150;

const state = {
    role: null,             // 'host' | 'guest' while connected
    ws: null,
    connected: false,
    manualClose: false,
    retriesLeft: 0,
    turnHolder: null,       // 'host' | 'guest'
    peerName: null,
    session: { port: DEFAULT_PORT, token: null },
    typingActive: false,
    typingTimer: null,
    streamPending: null,
    streamTimer: null,
};

function getCtx() {
    return SillyTavern.getContext();
}

function settings() {
    const ctx = getCtx();
    ctx.extensionSettings[MOD] = Object.assign(
        { role: 'host', port: DEFAULT_PORT, autoPass: false, tunnel: false, lastInvite: '' },
        ctx.extensionSettings[MOD] ?? {},
    );
    return ctx.extensionSettings[MOD];
}

function saveSettings() {
    getCtx().saveSettingsDebounced();
}

function nowString() {
    return new Date().toLocaleString();
}

function myTurn() {
    return state.connected && state.turnHolder === state.role;
}

function toast(kind, msg) {
    if (window.toastr) toastr[kind](msg, 'ST-Together');
}

// ---------------------------------------------------------------- chat ops

function findByUid(uid) {
    if (!uid) return -1;
    return getCtx().chat.findIndex(m => m?.extra?.stg_uid === uid);
}

function ensureUid(mes) {
    mes.extra = mes.extra ?? {};
    if (!mes.extra.stg_uid) mes.extra.stg_uid = crypto.randomUUID();
    return mes.extra.stg_uid;
}

async function pushMessage({ name, text, isUser, uid, sendDate, remote = false, save = true }) {
    const ctx = getCtx();
    const mes = {
        name: name,
        is_user: !!isUser,
        is_system: false,
        send_date: sendDate || nowString(),
        mes: String(text ?? ''),
        extra: { stg_uid: uid || crypto.randomUUID() },
    };
    if (remote) mes.extra.stg_remote = true;
    ctx.chat.push(mes);
    ctx.addOneMessage(mes);
    if (save) await ctx.saveChat();
    return mes;
}

async function updateMessageText(index, text) {
    const ctx = getCtx();
    ctx.chat[index].mes = String(text ?? '');
    try {
        ctx.updateMessageBlock(index, ctx.chat[index]);
    } catch (error) {
        console.error(`[${MOD}] updateMessageBlock failed, reloading chat`, error);
        await ctx.reloadCurrentChat();
    }
    await ctx.saveChat();
}

// ------------------------------------------------------------- websocket

function wsSend(obj) {
    if (state.ws && state.ws.readyState === 1) {
        state.ws.send(JSON.stringify(obj));
    }
}

function connect(url, token, role) {
    state.manualClose = false;
    setStatus(`Connecting to ${url} ...`);
    let ws;
    try {
        ws = new WebSocket(url);
    } catch (error) {
        setStatus(`Bad address: ${error.message}`);
        return;
    }
    state.ws = ws;
    state.session.token = token;

    ws.addEventListener('open', () => {
        wsSend({ t: 'hello', token, role, name: getCtx().name1 || role });
    });
    ws.addEventListener('message', (event) => {
        let frame;
        try { frame = JSON.parse(event.data); } catch { return; }
        try { onFrame(frame); } catch (error) { console.error(`[${MOD}] frame error`, error, frame); }
    });
    ws.addEventListener('close', (event) => {
        const wasConnected = state.connected;
        state.connected = false;
        state.ws = null;
        state.turnHolder = null;
        document.body.classList.remove('stg-guest-active');
        hideTyping();
        removeGhost();
        applyTurnUI();
        setStatus(event.reason ? `Disconnected: ${event.reason}` : 'Disconnected.');
        if (!state.manualClose && wasConnected && role === 'guest' && state.retriesLeft > 0) {
            state.retriesLeft--;
            setStatus(`Connection lost, retrying (${state.retriesLeft} left) ...`);
            setTimeout(() => connect(url, token, role), 2000);
        }
    });
    ws.addEventListener('error', () => {
        setStatus('Connection error.');
    });
}

function disconnect() {
    state.manualClose = true;
    state.retriesLeft = 0;
    if (state.ws) state.ws.close(1000, 'leaving');
    state.connected = false;
    state.role = null;
    state.turnHolder = null;
    document.body.classList.remove('stg-guest-active');
    hideTyping();
    removeGhost();
    applyTurnUI();
}

// --------------------------------------------------------- frame handling

function onFrame(frame) {
    switch (frame.t) {
        case 'welcome': {
            state.connected = true;
            state.role = frame.role;
            state.turnHolder = frame.turn;
            state.retriesLeft = 3;
            document.body.classList.toggle('stg-guest-active', frame.role === 'guest');
            setStatus(`Connected as ${frame.role}.`);
            applyTurnUI();
            return;
        }
        case 'snapshot': return void applySnapshot(frame);
        case 'snapshot.req': return void answerSnapshot(frame);
        case 'msg.user': return void onRemoteUserMessage(frame);
        case 'exec': return void onExec(frame);
        case 'gen.start': {
            if (state.role === 'guest') showGhost();
            return;
        }
        case 'gen.token': {
            if (state.role === 'guest') updateGhost(frame.text);
            return;
        }
        case 'gen.end': return void onGenEnd(frame);
        case 'gen.abort': {
            removeGhost();
            return;
        }
        case 'turn': {
            const wasMine = myTurn();
            state.turnHolder = frame.holder;
            applyTurnUI();
            if (!wasMine && myTurn()) toast('info', 'Your turn.');
            return;
        }
        case 'typing': {
            if (frame.active) showTyping(frame.name);
            else hideTyping();
            return;
        }
        case 'peer': {
            if (frame.role !== state.role) state.peerName = frame.online ? frame.name : state.peerName;
            toast('info', `${frame.name} ${frame.online ? 'joined' : 'left'}.`);
            applyTurnUI();
            return;
        }
        case 'error': {
            const messages = {
                'not-your-turn': 'Not your turn.',
                'bad-token': 'Wrong session token.',
                'no-host': 'Host is not connected.',
                'host-taken': 'A host is already connected.',
                'room-full': 'Session is full.',
            };
            toast('warning', messages[frame.code] ?? frame.msg ?? frame.code);
            return;
        }
        default:
            return;
    }
}

async function applySnapshot(frame) {
    if (state.role !== 'guest') return;
    const ctx = getCtx();
    const snapshot = frame.messages ?? [];
    const snapshotUids = new Set(snapshot.map(m => m.uid));
    let added = 0, updated = 0, removed = 0;

    // Remove host-origin messages the host no longer has (deletions).
    // Never remove this guest's own messages; they may still be in flight.
    for (let i = ctx.chat.length - 1; i >= 0; i--) {
        const m = ctx.chat[i];
        if (m?.extra?.stg_remote && m.extra.stg_uid && !snapshotUids.has(m.extra.stg_uid)) {
            ctx.chat.splice(i, 1);
            removed++;
        }
    }
    // Update texts that changed (edits, swipes), add what is missing.
    for (const m of snapshot) {
        const idx = findByUid(m.uid);
        if (idx === -1) {
            await pushMessage({
                name: m.name, text: m.text, isUser: m.isUser,
                uid: m.uid, sendDate: m.sendDate, remote: true, save: false,
            });
            added++;
        } else if (ctx.chat[idx].mes !== m.text) {
            ctx.chat[idx].mes = m.text;
            updated++;
        }
    }

    await ctx.saveChat();
    if (removed > 0 || updated > 0) {
        await ctx.reloadCurrentChat();
    }
    if (typeof frame.turn === 'string') state.turnHolder = frame.turn;
    applyTurnUI();
    const changes = added + updated + removed;
    toast('success', changes
        ? `Synced with host: ${added} added, ${updated} updated, ${removed} removed.`
        : 'Chat already in sync.');
}

function buildSnapshotMessages() {
    const ctx = getCtx();
    return ctx.chat
        .filter(m => !m.is_system)
        .map(m => ({
            uid: ensureUid(m),
            name: m.name,
            isUser: !!m.is_user,
            text: m.mes,
            sendDate: m.send_date,
        }));
}

async function answerSnapshot(frame) {
    if (state.role !== 'host') return;
    const ctx = getCtx();
    const messages = buildSnapshotMessages();
    await ctx.saveChat();
    wsSend({ t: 'snapshot', reqId: frame.reqId, chatName: ctx.getCurrentChatId?.() ?? '', messages });
}

let resyncTimer = null;
function scheduleResync() {
    if (!state.connected || state.role !== 'host') return;
    if (resyncTimer) clearTimeout(resyncTimer);
    resyncTimer = setTimeout(async () => {
        resyncTimer = null;
        if (!state.connected || state.role !== 'host') return;
        const ctx = getCtx();
        const messages = buildSnapshotMessages();
        await ctx.saveChat();
        wsSend({ t: 'snapshot', chatName: ctx.getCurrentChatId?.() ?? '', messages });
    }, 800);
}

async function onRemoteUserMessage(frame) {
    if (findByUid(frame.uid) !== -1) return;
    hideTyping();
    await pushMessage({
        name: frame.name, text: frame.text, isUser: true,
        uid: frame.uid, sendDate: frame.sendDate, remote: true,
    });
}

async function onExec(frame) {
    if (state.role !== 'host') return;
    const ctx = getCtx();
    try {
        if (frame.kind === 'message') {
            if (findByUid(frame.uid) === -1) {
                hideTyping();
                await pushMessage({
                    name: frame.name, text: frame.text, isUser: true,
                    uid: frame.uid, sendDate: frame.sendDate, remote: true,
                });
            }
            await ctx.generate('normal');
        } else if (frame.kind === 'continue') {
            await ctx.generate('continue');
        } else if (frame.kind === 'botreply') {
            await ctx.generate('normal');
        }
    } catch (error) {
        console.error(`[${MOD}] exec failed`, error);
        toast('error', `Failed to run ${frame.kind}: ${error?.message ?? error}`);
        wsSend({ t: 'gen.abort' });
    }
}

async function onGenEnd(frame) {
    if (state.role !== 'guest') return;
    removeGhost();
    const idx = findByUid(frame.uid);
    if (idx !== -1) {
        await updateMessageText(idx, frame.text);
    } else {
        await pushMessage({
            name: frame.name, text: frame.text, isUser: false,
            uid: frame.uid, sendDate: frame.sendDate, remote: true,
        });
    }
}

// -------------------------------------------------- host generation relay

function flushStream() {
    if (state.streamTimer) { clearTimeout(state.streamTimer); state.streamTimer = null; }
    if (state.streamPending != null) {
        wsSend({ t: 'gen.token', text: state.streamPending });
        state.streamPending = null;
    }
}

function hookHostEvents() {
    const ctx = getCtx();
    const { eventSource, eventTypes } = ctx;

    eventSource.on(eventTypes.MESSAGE_SENT, (index) => {
        if (!state.connected || state.role !== 'host') return;
        const mes = getCtx().chat[index];
        if (!mes || mes.extra?.stg_remote) return;
        const uid = ensureUid(mes);
        sendTypingStop();
        wsSend({ t: 'msg.user', uid, name: mes.name, text: mes.mes, sendDate: mes.send_date });
    });

    eventSource.on(eventTypes.GENERATION_STARTED, (_type, _options, dryRun) => {
        if (!state.connected || state.role !== 'host' || dryRun) return;
        wsSend({ t: 'gen.start' });
    });

    eventSource.on(eventTypes.STREAM_TOKEN_RECEIVED, (text) => {
        if (!state.connected || state.role !== 'host' || typeof text !== 'string') return;
        state.streamPending = text;
        if (!state.streamTimer) {
            state.streamTimer = setTimeout(flushStream, STREAM_THROTTLE_MS);
        }
    });

    eventSource.on(eventTypes.GENERATION_ENDED, () => {
        if (!state.connected || state.role !== 'host') return;
        flushStream();
        const last = getCtx().chat.at(-1);
        if (!last || last.is_user || last.is_system) {
            wsSend({ t: 'gen.abort' });
            return;
        }
        const uid = ensureUid(last);
        wsSend({ t: 'gen.end', uid, name: last.name, text: last.mes, sendDate: last.send_date });
    });

    eventSource.on(eventTypes.GENERATION_STOPPED, () => {
        if (!state.connected || state.role !== 'host') return;
        flushStream();
        wsSend({ t: 'gen.abort' });
    });

    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        if (state.connected && state.role === 'host') {
            toast('warning', 'Chat changed while hosting. Guests are still synced to the old chat; stop and restart the session.');
        }
    });

    // Edits, deletes, and swipes on the host push a full snapshot; guests reconcile.
    for (const type of [eventTypes.MESSAGE_EDITED, eventTypes.MESSAGE_DELETED, eventTypes.MESSAGE_SWIPED]) {
        eventSource.on(type, scheduleResync);
    }
}

// -------------------------------------------------------------- guest send

async function guestSend() {
    const textarea = document.getElementById('send_textarea');
    const text = (textarea?.value ?? '').trim();
    if (!text) return;
    const uid = crypto.randomUUID();
    const sendDate = nowString();
    sendTypingStop();
    wsSend({ t: 'msg.user', uid, text, sendDate });
    textarea.value = '';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await pushMessage({ name: getCtx().name1 || 'You', text, isUser: true, uid, sendDate });
}

function interceptSend(event) {
    if (!state.connected) return;
    if (!myTurn()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        toast('warning', 'Not your turn.');
        return;
    }
    if (state.role === 'guest') {
        event.preventDefault();
        event.stopImmediatePropagation();
        guestSend();
    }
    // Host on their turn: let the native ST send flow run.
}

function hookSendInterception() {
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
        if (event.target?.id !== 'send_textarea') return;
        interceptSend(event);
    }, true);

    document.addEventListener('click', (event) => {
        if (!event.target?.closest?.('#send_but')) return;
        interceptSend(event);
    }, true);
}

// ------------------------------------------------------- typing indicator

function sendTypingStart() {
    if (!state.connected || !myTurn()) return;
    if (!state.typingActive) {
        state.typingActive = true;
        wsSend({ t: 'typing', active: true });
    }
    if (state.typingTimer) clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(sendTypingStop, TYPING_IDLE_MS);
}

function sendTypingStop() {
    if (state.typingTimer) { clearTimeout(state.typingTimer); state.typingTimer = null; }
    if (state.typingActive) {
        state.typingActive = false;
        wsSend({ t: 'typing', active: false });
    }
}

function hookTyping() {
    document.addEventListener('input', (event) => {
        if (event.target?.id !== 'send_textarea') return;
        if (event.target.value) sendTypingStart();
        else sendTypingStop();
    }, true);
}

function showTyping(name) {
    const el = document.getElementById('stg_typing');
    if (!el) return;
    el.querySelector('.stg-typing-name').textContent = `${name} is writing`;
    el.classList.add('stg-visible');
}

function hideTyping() {
    document.getElementById('stg_typing')?.classList.remove('stg-visible');
}

// --------------------------------------------------- guest stream preview

function showGhost() {
    removeGhost();
    const chat = document.getElementById('chat');
    if (!chat) return;
    const ghost = document.createElement('div');
    ghost.id = 'stg_stream';
    ghost.innerHTML = '<div class="stg-ghost-name"></div><div class="stg-ghost-text"></div>';
    ghost.querySelector('.stg-ghost-name').textContent = getCtx().name2 || 'Bot';
    chat.appendChild(ghost);
    chat.scrollTop = chat.scrollHeight;
}

function updateGhost(text) {
    let ghost = document.getElementById('stg_stream');
    if (!ghost) { showGhost(); ghost = document.getElementById('stg_stream'); }
    if (!ghost) return;
    ghost.querySelector('.stg-ghost-text').textContent = String(text ?? '');
    const chat = document.getElementById('chat');
    if (chat) chat.scrollTop = chat.scrollHeight;
}

function removeGhost() {
    document.getElementById('stg_stream')?.remove();
}

// ---------------------------------------------------------------- turn UI

function applyTurnUI() {
    const bar = document.getElementById('stg_bar');
    const textarea = document.getElementById('send_textarea');
    if (!bar) return;

    if (!state.connected) {
        bar.classList.add('stg-hidden');
        if (textarea) {
            textarea.disabled = false;
            textarea.placeholder = '';
        }
        return;
    }

    bar.classList.remove('stg-hidden');
    const mine = myTurn();
    document.getElementById('stg_turn_label').textContent = mine
        ? 'Your turn'
        : `Waiting: ${state.peerName ?? 'other player'}'s turn`;
    bar.classList.toggle('stg-my-turn', mine);
    for (const id of ['stg_continue', 'stg_botreply', 'stg_pass']) {
        document.getElementById(id)?.classList.toggle('disabled', !mine);
    }
    if (textarea) {
        textarea.disabled = !mine;
        textarea.placeholder = mine ? 'Your turn. Type a message...' : 'Waiting for the other player...';
    }
}

function injectActionBar() {
    const formSheld = document.getElementById('form_sheld');
    if (!formSheld || document.getElementById('stg_bar')) return;
    const bar = document.createElement('div');
    bar.id = 'stg_bar';
    bar.className = 'stg-hidden';
    bar.innerHTML = `
        <span id="stg_turn_label"></span>
        <div class="stg-bar-buttons">
            <div id="stg_continue" class="menu_button" title="Extend the bot's last message">Continue</div>
            <div id="stg_botreply" class="menu_button" title="Bot speaks again without a new message">Bot Reply</div>
            <div id="stg_pass" class="menu_button" title="Hand the turn to the other player">Pass Turn</div>
        </div>`;
    formSheld.prepend(bar);

    const guarded = (kind) => () => {
        if (!myTurn()) return toast('warning', 'Not your turn.');
        wsSend({ t: 'action', kind });
    };
    document.getElementById('stg_continue').addEventListener('click', guarded('continue'));
    document.getElementById('stg_botreply').addEventListener('click', guarded('botreply'));
    document.getElementById('stg_pass').addEventListener('click', guarded('pass'));

    const typing = document.createElement('div');
    typing.id = 'stg_typing';
    typing.innerHTML = `
        <span class="stg-typing-name"></span>
        <span class="stg-dots"><span></span><span></span><span></span></span>`;
    formSheld.prepend(typing);
}

// ---------------------------------------------------------- settings panel

function setStatus(text) {
    const el = document.getElementById('stg_status');
    if (el) el.textContent = text;
}

function parseInvite(raw) {
    const value = String(raw ?? '').trim();
    let match = value.match(/^stg:\/\/([^#\s]+)#(\S+)$/) || value.match(/^(wss?:\/\/[^#\s]+)#(\S+)$/);
    if (!match) return null;
    let addr = match[1];
    const token = match[2];
    if (!addr.startsWith('ws://') && !addr.startsWith('wss://')) {
        addr = addr.includes(':') ? `ws://${addr}` : `wss://${addr}`;
    }
    return { url: addr, token };
}

async function pluginAvailable() {
    try {
        const response = await fetch('/api/plugins/st-together/status', {
            headers: getCtx().getRequestHeaders(),
        });
        return response.ok;
    } catch {
        return false;
    }
}

async function refreshPluginGate() {
    const ok = await pluginAvailable();
    const hostRadio = document.querySelector('input[name="stg_role"][value="host"]');
    const warn = document.getElementById('stg_plugin_warn');
    if (!hostRadio || !warn) return ok;
    hostRadio.disabled = !ok;
    warn.classList.toggle('stg-hidden', ok);
    document.getElementById('stg_start')?.classList.toggle('disabled', !ok);
    if (!ok && document.querySelector('input[name="stg_role"][value="host"]').checked) {
        // Show the guest view without overwriting the saved role preference.
        document.querySelector('input[name="stg_role"][value="guest"]').checked = true;
        $('#stg_host_block').addClass('stg-hidden');
        $('#stg_guest_block').removeClass('stg-hidden');
    }
    return ok;
}

async function hostStart() {
    if (!await pluginAvailable()) {
        toast('error', 'The ST-Together server plugin is not responding. Host mode needs it installed and enableServerPlugins: true.');
        refreshPluginGate();
        return;
    }
    const ctx = getCtx();
    const s = settings();
    const port = Number(document.getElementById('stg_port').value) || DEFAULT_PORT;
    const autoPass = document.getElementById('stg_autopass').checked;
    const tunnel = document.getElementById('stg_tunnel').checked;
    s.port = port;
    s.autoPass = autoPass;
    s.tunnel = tunnel;
    saveSettings();
    setStatus(tunnel ? 'Starting session and Cloudflare tunnel (can take up to a minute on first run) ...' : 'Starting session ...');
    try {
        const response = await fetch('/api/plugins/st-together/start', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ port, autoPass, tunnel }),
        });
        const raw = await response.text();
        let data;
        try {
            data = JSON.parse(raw);
        } catch {
            if (response.status === 403) {
                throw new Error('Session expired (403). Refresh this SillyTavern tab and try again.');
            }
            throw new Error(`HTTP ${response.status}: ${raw.slice(0, 100) || response.statusText}`);
        }
        if (!response.ok) throw new Error(data.error ?? response.statusText);
        state.session.port = data.port;
        state.session.token = data.token;
        const invite = data.tunnelUrl
            ? `stg://${data.tunnelUrl.replace(/^https:\/\//, '')}#${data.token}`
            : `stg://127.0.0.1:${data.port}#${data.token}`;
        document.getElementById('stg_invite_out').value = invite;
        connect(`ws://127.0.0.1:${data.port}`, data.token, 'host');
    } catch (error) {
        setStatus(`Start failed: ${error.message}`);
        toast('error', `Could not start session: ${error.message}`);
    }
}

async function hostStop() {
    disconnect();
    try {
        await fetch('/api/plugins/st-together/stop', {
            method: 'POST',
            headers: getCtx().getRequestHeaders(),
            body: JSON.stringify({}),
        });
    } catch { /* server may already be gone */ }
    document.getElementById('stg_invite_out').value = '';
    setStatus('Session stopped.');
}

function guestJoin() {
    const raw = document.getElementById('stg_invite_in').value;
    const invite = parseInvite(raw);
    if (!invite) {
        toast('error', 'Invalid invite code. Expected stg://host:port#token');
        return;
    }
    const s = settings();
    s.lastInvite = raw.trim();
    saveSettings();
    state.retriesLeft = 3;
    connect(invite.url, invite.token, 'guest');
}

function injectSettingsPanel() {
    const s = settings();
    const html = `
    <div id="stg_settings" class="stg-extension-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>ST-Together</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label"><input type="radio" name="stg_role" value="host" ${s.role === 'host' ? 'checked' : ''}> Host (chat lives on this PC)</label>
                <label class="checkbox_label"><input type="radio" name="stg_role" value="guest" ${s.role === 'guest' ? 'checked' : ''}> Join (connect to a host)</label>
                <div id="stg_plugin_warn" class="stg-hidden stg-warn">
                    Host mode is unavailable: the ST-Together server plugin is not responding.
                    Clone this repo into SillyTavern's <code>plugins/st-together</code> folder, set
                    <code>enableServerPlugins: true</code> in config.yaml, and restart SillyTavern.
                    Joining someone else's session works without it.
                    <span id="stg_recheck" class="stg-link">Recheck</span>
                </div>
                <hr>
                <div id="stg_host_block" class="${s.role === 'host' ? '' : 'stg-hidden'}">
                    <label>Port <input id="stg_port" class="text_pole" type="number" min="1024" max="65535" value="${s.port}"></label>
                    <label class="checkbox_label"><input id="stg_autopass" type="checkbox" ${s.autoPass ? 'checked' : ''}> Auto-pass turn after bot reply</label>
                    <label class="checkbox_label"><input id="stg_tunnel" type="checkbox" ${s.tunnel ? 'checked' : ''}> Expose via Cloudflare tunnel (for remote friends)</label>
                    <div class="stg-row">
                        <div id="stg_start" class="menu_button">Start Session</div>
                        <div id="stg_stop" class="menu_button">Stop</div>
                    </div>
                    <label>Invite code
                        <div class="stg-row">
                            <input id="stg_invite_out" class="text_pole" type="text" readonly placeholder="Start a session to get an invite code">
                            <div id="stg_copy" class="menu_button" title="Copy invite">Copy</div>
                        </div>
                    </label>
                    <small>Without the tunnel the invite only works on this machine (testing). With it, the invite is a temporary trycloudflare URL that dies when you stop the session.</small>
                </div>
                <div id="stg_guest_block" class="${s.role === 'guest' ? '' : 'stg-hidden'}">
                    <label>Invite code
                        <input id="stg_invite_in" class="text_pole" type="text" placeholder="stg://host:port#token" value="${s.lastInvite.replace(/"/g, '&quot;')}">
                    </label>
                    <div class="stg-row">
                        <div id="stg_join" class="menu_button">Join</div>
                        <div id="stg_leave" class="menu_button">Leave</div>
                    </div>
                    <small>Open the character chat you want to mirror into BEFORE joining, ideally a fresh one.</small>
                </div>
                <hr>
                <div>Status: <span id="stg_status">Idle.</span></div>
            </div>
        </div>
    </div>`;
    $('#extensions_settings2').append(html);

    $('input[name="stg_role"]').on('change', function () {
        const s2 = settings();
        s2.role = this.value;
        saveSettings();
        $('#stg_host_block').toggleClass('stg-hidden', this.value !== 'host');
        $('#stg_guest_block').toggleClass('stg-hidden', this.value !== 'guest');
    });
    $('#stg_start').on('click', hostStart);
    $('#stg_stop').on('click', hostStop);
    $('#stg_join').on('click', guestJoin);
    $('#stg_leave').on('click', () => { disconnect(); setStatus('Left the session.'); });
    $('#stg_copy').on('click', () => {
        const value = document.getElementById('stg_invite_out').value;
        if (value) navigator.clipboard.writeText(value).then(() => toast('success', 'Invite copied.'));
    });
    $('#stg_recheck').on('click', async () => {
        toast('info', await refreshPluginGate() ? 'Server plugin found.' : 'Still not responding.');
    });
    refreshPluginGate();
}

// -------------------------------------------------------------------- init

jQuery(() => {
    try {
        injectSettingsPanel();
        injectActionBar();
        hookHostEvents();
        hookSendInterception();
        hookTyping();
        console.log(`[${MOD}] loaded`);
    } catch (error) {
        console.error(`[${MOD}] failed to initialize`, error);
    }
});
