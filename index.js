// ST-Together: two SillyTavern instances, one shared chat, fluid turns.
// Host role: relays the authoritative chat through the st-together server
// plugin and executes all LLM actions. Guest role: mirrors the chat and
// sends intents (messages, continue, bot reply, pass) to the host.

const MOD = 'st-together';
const WS_PATH = '/api/plugins/st-together/ws';
const TYPING_IDLE_MS = 2500;
const STREAM_THROTTLE_MS = 150;

// Build a ws(s):// URL for a SillyTavern origin (its own or a tunnel's),
// reusing http->ws / https->wss so it inherits the origin's TLS.
function wsUrlForOrigin(origin) {
    return origin.replace(/^http/i, 'ws').replace(/\/+$/, '') + WS_PATH;
}

// This browser's own SillyTavern origin, as a WebSocket URL.
function localWsUrl() {
    return wsUrlForOrigin(window.location.origin);
}

const state = {
    role: null,             // 'host' | 'guest' while connected
    ws: null,
    connected: false,
    manualClose: false,
    retriesLeft: 0,
    turnHolder: null,       // 'host' | 'guest'
    peerName: null,
    session: { token: null },
    typingActive: false,
    typingTimer: null,
    streamPending: null,
    streamTimer: null,
    remoteAvatars: {},
    avatarCache: null,
    sharedChatId: null,
    sharePaused: false,
    mirrorChatId: null,
    mirrorPaused: false,
    hostAway: false,
    suppressChatPrompt: false,
    personas: {},           // host: guest name -> { name, description }
    myAvatarSent: false,    // have we shared this player's persona avatar yet
};

function getCtx() {
    return SillyTavern.getContext();
}

function settings() {
    const ctx = getCtx();
    ctx.extensionSettings[MOD] = Object.assign(
        {
            role: 'guest', autoPass: false, tunnel: true, announcePlayers: true, sharePersonaDesc: true,
            participantsTemplate: '', participantsPosition: 1, participantsDepth: 4, lastInvite: '',
        },
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

async function stgPrompt(title, text, buttons) {
    // Native ST popup: last option doubles as the OK button, so Escape or
    // closing the dialog resolves to the safe choice (Not now / Keep).
    const ctx = getCtx();
    if (typeof ctx.callGenericPopup === 'function') {
        try {
            const customButtons = buttons.slice(0, -1).map((b, i) => ({ text: b.label, result: 100 + i }));
            const result = await ctx.callGenericPopup(text, 1, '', {
                okButton: buttons[buttons.length - 1].label,
                customButtons,
            });
            const index = Number(result) - 100;
            return buttons[index]?.value ?? buttons[buttons.length - 1].value;
        } catch (error) {
            console.error(`[${MOD}] native popup failed, using fallback`, error);
        }
    }
    return domPrompt(title, text, buttons);
}

function domPrompt(title, text, buttons) {
    return new Promise((resolve) => {
        document.getElementById('stg_modal')?.remove();
        const overlay = document.createElement('div');
        overlay.id = 'stg_modal';
        const box = document.createElement('div');
        box.className = 'stg-modal-box';
        const heading = document.createElement('div');
        heading.className = 'stg-modal-title';
        heading.textContent = title;
        const body = document.createElement('div');
        body.className = 'stg-modal-text';
        body.textContent = text;
        const row = document.createElement('div');
        row.className = 'stg-row';
        for (const button of buttons) {
            const el = document.createElement('div');
            el.className = 'menu_button';
            el.textContent = button.label;
            el.addEventListener('click', () => { overlay.remove(); resolve(button.value); });
            row.appendChild(el);
        }
        box.append(heading, body, row);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
    });
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

function buildMessage({ name, text, isUser, uid, sendDate, remote = false }) {
    const mes = {
        name: name,
        is_user: !!isUser,
        is_system: false,
        send_date: sendDate || nowString(),
        mes: String(text ?? ''),
        extra: { stg_uid: uid || crypto.randomUUID() },
    };
    if (remote) mes.extra.stg_remote = true;
    // Remote messages (the other player's user messages and the shared bot)
    // carry a synced avatar so they don't fall back to this instance's own.
    if (remote && state.remoteAvatars[mes.name]) {
        mes.force_avatar = state.remoteAvatars[mes.name];
    }
    return mes;
}

async function pushMessage(opts) {
    const ctx = getCtx();
    const mes = buildMessage(opts);
    ctx.chat.push(mes);
    ctx.addOneMessage(mes);
    if (opts.save !== false) await ctx.saveChat();
    return mes;
}

// Re-render the in-memory chat[] to the DOM without touching disk or the
// character context. reloadCurrentChat() would re-read the chat file keyed
// to the current character, which bounces to "you deleted a character/chat"
// when the guest's mirror chat belongs to a character they do not have.
async function redrawChat() {
    const ctx = getCtx();
    try {
        if (typeof ctx.clearChat === 'function') await ctx.clearChat();
        await ctx.printMessages();
    } catch (error) {
        console.error(`[${MOD}] redraw failed`, error);
    }
}

async function updateMessageText(index, text) {
    const ctx = getCtx();
    ctx.chat[index].mes = String(text ?? '');
    try {
        ctx.updateMessageBlock(index, ctx.chat[index]);
    } catch (error) {
        console.error(`[${MOD}] updateMessageBlock failed, redrawing chat`, error);
        await redrawChat();
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
        hideVotePrompt();
        removeGhost();
        clearParticipantsPrompt();
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
    state.personas = {};
    state.myAvatarSent = false;
    document.body.classList.remove('stg-guest-active');
    hideTyping();
    hideVotePrompt();
    removeGhost();
    clearParticipantsPrompt();
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
            state.hostAway = false;
            state.sharePaused = false;
            state.mirrorPaused = false;
            state.personas = {};
            state.myAvatarSent = false;
            const currentChat = getCtx().getCurrentChatId?.() ?? null;
            if (frame.role === 'host') {
                state.sharedChatId = currentChat;
                if (!currentChat) {
                    // Welcome screen / no real chat open: don't share the
                    // assistant hint messages. Wait for a chat to be opened.
                    state.sharePaused = true;
                    wsSend({ t: 'share.paused', paused: true });
                    setStatus('Connected as host. Open a chat to start sharing it.');
                    applyTurnUI();
                    return;
                }
            } else {
                state.mirrorChatId = currentChat;
                state.hostAway = !!frame.paused;
                sendPersona();
            }
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
            if (state.role === 'guest' && !state.mirrorPaused) showGhost(frame.name);
            return;
        }
        case 'gen.token': {
            if (state.role === 'guest' && !state.mirrorPaused) updateGhost(frame.text);
            return;
        }
        case 'share.paused': {
            if (state.role === 'guest') {
                state.hostAway = !!frame.paused;
                applyTurnUI();
                if (frame.paused) toast('info', 'Host stepped out of the shared chat.');
            }
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
            if (state.role === 'host' && frame.role === 'guest') {
                if (frame.online) {
                    sendPersona(); // introduce the host's persona to the new guest
                } else {
                    delete state.personas[frame.name];
                    updateParticipantsPrompt();
                }
            }
            applyTurnUI();
            return;
        }
        case 'persona': {
            if (state.role === 'host') {
                state.personas[frame.name] = { name: frame.name, description: frame.description || '' };
                updateParticipantsPrompt();
            }
            if (frame.avatar) ensureRemoteAvatar(frame.avatar);
            return;
        }
        case 'vote': {
            if (frame.kind === 'request') {
                showVotePrompt(frame.name);
            } else if (frame.kind === 'passed') {
                hideVotePrompt();
                toast('info', 'Swiping the response...');
            } else if (frame.kind === 'failed') {
                hideVotePrompt();
                toast('info', `${frame.name ?? 'The other player'} kept the response.`);
            }
            return;
        }
        case 'error': {
            const messages = {
                'not-your-turn': 'Not your turn.',
                'bad-token': 'Wrong session token.',
                'no-host': 'Host is not connected.',
                'host-taken': 'A host is already connected.',
                'room-full': 'Session is full.',
                'host-away': 'Host is in another chat right now.',
                'no-peer': 'No one else is here to vote.',
            };
            toast('warning', messages[frame.code] ?? frame.msg ?? frame.code);
            return;
        }
        default:
            return;
    }
}

// Host: capture the current character's portrait once per character, as a
// small base64 payload the guest can store locally.
async function getBotAvatarB64() {
    const ctx = getCtx();
    const char = ctx.characters?.[ctx.characterId];
    if (!char?.avatar) return null;
    if (state.avatarCache?.chid === ctx.characterId) return state.avatarCache.payload;
    const sources = [
        `/thumbnail?type=avatar&file=${encodeURIComponent(char.avatar)}`,
        `/characters/${encodeURIComponent(char.avatar)}`,
    ];
    for (const src of sources) {
        try {
            const response = await fetch(src);
            if (!response.ok) continue;
            const blob = await response.blob();
            if (!blob.size) continue;
            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
            const [meta, b64] = String(dataUrl).split(',');
            const format = meta.includes('png') ? 'png' : meta.includes('webp') ? 'webp' : 'jpg';
            const payload = { name: char.name, format, b64 };
            state.avatarCache = { chid: ctx.characterId, payload };
            return payload;
        } catch { /* try the next source */ }
    }
    return null;
}

// Guest: save the host's character portrait into local ST images once,
// then reference it via force_avatar on mirrored bot messages.
async function ensureRemoteAvatar(card) {
    if (!card?.b64 || !card.name || state.remoteAvatars[card.name]) return;
    try {
        const response = await fetch('/api/images/upload', {
            method: 'POST',
            headers: getCtx().getRequestHeaders(),
            body: JSON.stringify({
                image: card.b64,
                format: card.format || 'png',
                ch_name: 'ST-Together',
                filename: `avatar-${card.name}`,
            }),
        });
        if (!response.ok) return;
        const data = await response.json();
        if (data.path) {
            state.remoteAvatars[card.name] = data.path;
            applyAvatarRetroactively(card.name, data.path);
        }
    } catch { /* cosmetic only; sync continues without the portrait */ }
}

// An avatar can arrive after its messages are already rendered (persona
// avatars come in their own frame). Pin it onto existing messages and redraw.
function applyAvatarRetroactively(name, path) {
    const ctx = getCtx();
    let changed = false;
    for (const m of ctx.chat) {
        if (m?.extra?.stg_remote && m.name === name && m.force_avatar !== path) {
            m.force_avatar = path;
            changed = true;
        }
    }
    if (changed) redrawChat();
}

// This player's own persona avatar, read from the last message they sent
// (its rendered avatar is the persona thumbnail). user_avatar isn't exposed
// to extensions, so a rendered local message is the reliable source.
function getLocalPersonaAvatarSrc() {
    const ctx = getCtx();
    for (let i = ctx.chat.length - 1; i >= 0; i--) {
        const m = ctx.chat[i];
        if (m?.is_user && !m.extra?.stg_remote) {
            const src = document.querySelector(`#chat .mes[mesid="${i}"] .avatar img`)?.getAttribute('src') || '';
            if (/type=persona/.test(src)) return src;
            return null;
        }
    }
    return null;
}

async function fetchAvatarB64(src) {
    try {
        const response = await fetch(src);
        if (!response.ok) return null;
        const blob = await response.blob();
        if (!blob.size) return null;
        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
        const [meta, b64] = String(dataUrl).split(',');
        const format = meta.includes('png') ? 'png' : meta.includes('webp') ? 'webp' : 'jpg';
        return { format, b64 };
    } catch {
        return null;
    }
}

// ------------------------------------------------------------- personas

const PARTICIPANTS_KEY = 'ST_TOGETHER_PARTICIPANTS';
const DEFAULT_PARTICIPANTS_TEMPLATE =
`[Multiplayer scene: more than one person is taking part in this chat, each playing their own character. Treat them as distinct individuals and address them by name when it fits. Participants:
{{participants}}
Every user message is labelled with its sender's name; respond to whoever spoke most recently while staying aware of everyone present.]`;

function participantsSettings() {
    const s = settings();
    return {
        template: (s.participantsTemplate ?? '').trim() || DEFAULT_PARTICIPANTS_TEMPLATE,
        position: Number.isFinite(s.participantsPosition) ? s.participantsPosition : 1,
        depth: Number.isFinite(s.participantsDepth) ? s.participantsDepth : 4,
    };
}

// Build the exact text that gets injected, given the current roster.
function renderParticipantsPrompt() {
    const host = currentPersona();
    const guests = Object.values(state.personas);
    const line = (p) => `- ${p.name}${p.description ? `: ${p.description}` : ''}`;
    const roster = [host, ...guests].map(line).join('\n');
    return participantsSettings().template.replace('{{participants}}', roster);
}

function currentPersona() {
    const ctx = getCtx();
    return {
        name: ctx.name1 || 'Player',
        description: String(ctx.powerUserSettings?.persona_description ?? '').trim(),
    };
}

// Announce this player's persona: guests -> host (name, opt-in description,
// avatar); host -> guests (name, avatar) so each side can render the other's
// user messages with the right name and avatar. The avatar is only available
// once this player has a rendered message, so this is called again after they
// send one.
async function sendPersona() {
    if (!state.connected || (state.role !== 'guest' && state.role !== 'host')) return;
    const me = currentPersona();
    const frame = { t: 'persona', name: me.name };
    if (state.role === 'guest' && settings().sharePersonaDesc) frame.description = me.description;
    if (!state.myAvatarSent) {
        const src = getLocalPersonaAvatarSrc();
        if (src) {
            const av = await fetchAvatarB64(src);
            if (av) {
                frame.avatar = { name: me.name, format: av.format, b64: av.b64 };
                state.myAvatarSent = true;
            }
        }
    }
    wsSend(frame);
}

// Host: inject a system note describing every participant, so the model
// treats the players as distinct people and can address them by name. ST's
// own persona injection only ever covers the host's persona.
function updateParticipantsPrompt() {
    const ctx = getCtx();
    if (typeof ctx.setExtensionPrompt !== 'function') return;
    const s = settings();
    const guests = Object.values(state.personas);
    const cfg = participantsSettings();
    if (state.role !== 'host' || !state.connected || !s.announcePlayers || guests.length === 0) {
        ctx.setExtensionPrompt(PARTICIPANTS_KEY, '', cfg.position, cfg.depth, false, 0);
    } else {
        ctx.setExtensionPrompt(PARTICIPANTS_KEY, renderParticipantsPrompt(), cfg.position, cfg.depth, false, 0);
    }
    refreshParticipantsPreview();
}

function clearParticipantsPrompt() {
    const ctx = getCtx();
    if (typeof ctx.setExtensionPrompt === 'function') {
        const cfg = participantsSettings();
        ctx.setExtensionPrompt(PARTICIPANTS_KEY, '', cfg.position, cfg.depth, false, 0);
    }
}

// Advanced panel: show the exact text and location the AI receives right now.
function refreshParticipantsPreview() {
    const el = document.getElementById('stg_participants_preview');
    if (!el) return;
    const cfg = participantsSettings();
    const where = cfg.position === 0 ? 'top of the prompt' : `in-chat at depth ${cfg.depth}`;
    const hasGuests = Object.values(state.personas).length > 0;
    if (state.role === 'host' && state.connected && hasGuests) {
        el.value = `Injected as a system note, ${where}:\n\n${renderParticipantsPrompt()}`;
    } else {
        const roster = `${getCtx().name1 || 'You'}: (your persona)\n- (each guest appears here once they join)`;
        el.value = `Not active right now (needs a connected guest). Preview with sample roster, ${where}:\n\n${participantsSettings().template.replace('{{participants}}', roster)}`;
    }
}

async function applySnapshot(frame) {
    if (state.role !== 'guest' || state.mirrorPaused) return;
    const ctx = getCtx();
    state.mirrorChatId = ctx.getCurrentChatId?.() ?? null;
    await ensureRemoteAvatar(frame.botAvatar);
    const snapshot = frame.messages ?? [];

    // Fresh snapshot = the shared chat changed entirely. Replace the whole
    // mirror, including any untagged local messages (e.g. the guest's own
    // welcome-screen assistant hint) that a partial reconcile would leave
    // stranded at the top.
    if (frame.fresh) {
        ctx.chat.length = 0;
        for (const m of snapshot) {
            ctx.chat.push(buildMessage({
                name: m.name, text: m.text, isUser: m.isUser,
                uid: m.uid, sendDate: m.sendDate, remote: true,
            }));
        }
        await ctx.saveChat();
        await redrawChat();
        applyTurnUI();
        toast('success', snapshot.length
            ? `Now mirroring the shared chat (${snapshot.length} message(s)).`
            : 'Connected. Waiting for the host to share a chat.');
        return;
    }

    // Reconcile to match the host's snapshot ORDER exactly. A delete or edit
    // on the host can reshuffle messages, so we rebuild the list in snapshot
    // order (reusing existing message objects by uid to keep their local
    // state) rather than appending missing ones to the end, which would
    // scramble the order. The guest's own not-yet-echoed messages are kept
    // at the end.
    const snapshotUids = new Set(snapshot.map(m => m.uid));
    const existingByUid = new Map();
    for (const m of ctx.chat) {
        if (m?.extra?.stg_uid) existingByUid.set(m.extra.stg_uid, m);
    }
    let added = 0, updated = 0;
    const rebuilt = [];
    for (const m of snapshot) {
        const existing = existingByUid.get(m.uid);
        if (existing) {
            if (existing.mes !== m.text) { existing.mes = m.text; updated++; }
            if (!existing.is_user && !existing.force_avatar && state.remoteAvatars[existing.name]) {
                existing.force_avatar = state.remoteAvatars[existing.name];
            }
            rebuilt.push(existing);
        } else {
            rebuilt.push(buildMessage({
                name: m.name, text: m.text, isUser: m.isUser,
                uid: m.uid, sendDate: m.sendDate, remote: true,
            }));
            added++;
        }
    }
    // Keep this guest's own messages that the host hasn't echoed back yet.
    for (const m of ctx.chat) {
        const uid = m?.extra?.stg_uid;
        if (uid && !m.extra.stg_remote && !snapshotUids.has(uid)) rebuilt.push(m);
    }
    const removed = ctx.chat.filter(m => m?.extra?.stg_remote && m.extra.stg_uid && !snapshotUids.has(m.extra.stg_uid)).length;
    const orderChanged = rebuilt.length !== ctx.chat.length || rebuilt.some((m, i) => m !== ctx.chat[i]);

    ctx.chat.length = 0;
    ctx.chat.push(...rebuilt);
    await ctx.saveChat();
    if (orderChanged || added > 0 || updated > 0) {
        await redrawChat();
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
    // A snapshot reply (join or resume) is a full mirror replace, so mark it
    // fresh: the guest wipes its local view, including its own welcome hint.
    if (state.sharePaused) {
        // Not in the shared chat; answer empty so the guest is not fed the wrong chat.
        wsSend({ t: 'snapshot', reqId: frame.reqId, chatName: '', messages: [], fresh: true });
        return;
    }
    const messages = buildSnapshotMessages();
    try { await ctx.saveChat(); } catch { /* nothing saveable (welcome screen) */ }
    const botAvatar = await getBotAvatarB64();
    wsSend({ t: 'snapshot', reqId: frame.reqId, chatName: ctx.getCurrentChatId?.() ?? '', messages, botAvatar, fresh: true });
}

let resyncTimer = null;
function scheduleResync() {
    if (!state.connected || state.role !== 'host') return;
    if (resyncTimer) clearTimeout(resyncTimer);
    resyncTimer = setTimeout(async () => {
        resyncTimer = null;
        if (!state.connected || state.role !== 'host' || state.sharePaused) return;
        const ctx = getCtx();
        const messages = buildSnapshotMessages();
        try { await ctx.saveChat(); } catch { /* nothing saveable */ }
        const botAvatar = await getBotAvatarB64();
        wsSend({ t: 'snapshot', chatName: ctx.getCurrentChatId?.() ?? '', messages, botAvatar });
    }, 800);
}

// ---------------------------------------------------- chat switch handling

async function shareCurrentChat() {
    const ctx = getCtx();
    state.sharedChatId = ctx.getCurrentChatId?.() ?? null;
    state.sharePaused = false;
    wsSend({ t: 'share.paused', paused: false });
    const messages = buildSnapshotMessages();
    try { await ctx.saveChat(); } catch { /* nothing saveable */ }
    const botAvatar = await getBotAvatarB64();
    wsSend({ t: 'snapshot', fresh: true, chatName: state.sharedChatId ?? '', messages, botAvatar });
    setStatus('Connected as host.');
}

function setSharePaused() {
    state.sharePaused = true;
    wsSend({ t: 'share.paused', paused: true });
    setStatus('Sharing paused: you are outside the shared chat. Return to it to resume.');
}

async function onHostChatChanged() {
    const ctx = getCtx();
    const chatId = ctx.getCurrentChatId?.() ?? null;
    if (state.suppressChatPrompt) return;
    if (chatId && chatId === state.sharedChatId) {
        if (state.sharePaused) {
            state.sharePaused = false;
            wsSend({ t: 'share.paused', paused: false });
            setStatus('Connected as host.');
            toast('info', 'Back in the shared chat; sharing resumed.');
        }
        return;
    }
    if (!chatId) {
        if (!state.sharePaused) setSharePaused();
        return;
    }
    const choice = await stgPrompt(
        'ST-Together',
        'You switched chats while hosting a session. Share this chat with the other player?',
        [
            { label: 'Share this chat', value: 'share' },
            { label: 'Share a new chat', value: 'new' },
            { label: 'Not now', value: 'cancel' },
        ],
    );
    if (choice === 'share') {
        await shareCurrentChat();
        toast('success', 'Now sharing this chat.');
    } else if (choice === 'new') {
        state.suppressChatPrompt = true;
        try {
            await getCtx().executeSlashCommands('/newchat');
        } catch (error) {
            console.error(`[${MOD}] /newchat failed`, error);
            toast('error', 'Could not create a new chat.');
        }
        state.suppressChatPrompt = false;
        await shareCurrentChat();
        toast('success', 'Now sharing a fresh chat.');
    } else {
        setSharePaused();
    }
}

async function onGuestChatChanged() {
    const ctx = getCtx();
    const chatId = ctx.getCurrentChatId?.() ?? null;
    if (state.suppressChatPrompt) return;
    if (chatId && chatId === state.mirrorChatId) {
        if (state.mirrorPaused) {
            state.mirrorPaused = false;
            wsSend({ t: 'snapshot.get' });
            toast('info', 'Back in the mirror chat; resyncing.');
        }
        return;
    }
    if (!chatId) {
        state.mirrorPaused = true;
        return;
    }
    const choice = await stgPrompt(
        'ST-Together',
        'Mirror the multiplayer session into this chat instead?',
        [
            { label: 'Mirror here', value: 'here' },
            { label: 'Keep it where it was', value: 'keep' },
        ],
    );
    if (choice === 'here') {
        state.mirrorChatId = chatId;
        state.mirrorPaused = false;
        wsSend({ t: 'snapshot.get' });
    } else {
        state.mirrorPaused = true;
        setStatus('Mirror paused: the session chat is elsewhere. Return to it to resume.');
    }
}

async function onRemoteUserMessage(frame) {
    if (state.role === 'guest' && state.mirrorPaused) return;
    if (findByUid(frame.uid) !== -1) return;
    hideTyping();
    await pushMessage({
        name: frame.name, text: frame.text, isUser: true,
        uid: frame.uid, sendDate: frame.sendDate, remote: true,
    });
}

async function onExec(frame) {
    if (state.role !== 'host') return;
    if (state.sharePaused) {
        wsSend({ t: 'gen.abort' });
        return;
    }
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
        } else if (frame.kind === 'swipe') {
            const last = ctx.chat.at(-1);
            if (!last || last.is_user || last.is_system) {
                toast('warning', 'Nothing to swipe.');
                wsSend({ t: 'gen.abort' });
                return;
            }
            await ctx.generate('swipe');
        }
    } catch (error) {
        console.error(`[${MOD}] exec failed`, error);
        toast('error', `Failed to run ${frame.kind}: ${error?.message ?? error}`);
        wsSend({ t: 'gen.abort' });
    }
}

async function onGenEnd(frame) {
    if (state.role !== 'guest' || state.mirrorPaused) return;
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
        if (!state.connected || state.role !== 'host' || state.sharePaused) return;
        const mes = getCtx().chat[index];
        if (!mes || mes.extra?.stg_remote) return;
        const uid = ensureUid(mes);
        sendTypingStop();
        wsSend({ t: 'msg.user', uid, name: mes.name, text: mes.mes, sendDate: mes.send_date });
        if (!state.myAvatarSent) sendPersona(); // now a rendered message exists; capture the avatar
    });

    eventSource.on(eventTypes.GENERATION_STARTED, (_type, _options, dryRun) => {
        if (!state.connected || state.role !== 'host' || state.sharePaused || dryRun) return;
        const ctx = getCtx();
        // Refresh the participants note so the host's own persona is current
        // before the prompt is built.
        updateParticipantsPrompt();
        const name = ctx.characters?.[ctx.characterId]?.name || ctx.name2 || 'Bot';
        wsSend({ t: 'gen.start', name });
    });

    eventSource.on(eventTypes.STREAM_TOKEN_RECEIVED, (text) => {
        if (!state.connected || state.role !== 'host' || state.sharePaused || typeof text !== 'string') return;
        state.streamPending = text;
        if (!state.streamTimer) {
            state.streamTimer = setTimeout(flushStream, STREAM_THROTTLE_MS);
        }
    });

    eventSource.on(eventTypes.GENERATION_ENDED, () => {
        if (!state.connected || state.role !== 'host' || state.sharePaused) return;
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
        if (!state.connected || state.role !== 'host' || state.sharePaused) return;
        flushStream();
        wsSend({ t: 'gen.abort' });
    });

    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        if (!state.connected) return;
        if (state.role === 'host') onHostChatChanged();
        if (state.role === 'guest') onGuestChatChanged();
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
    if (!state.myAvatarSent) sendPersona(); // now a rendered message exists; capture the avatar
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

function showVotePrompt(name) {
    const el = document.getElementById('stg_vote_prompt');
    if (!el) return;
    document.getElementById('stg_vote_text').textContent = `${name} wants to swipe this response`;
    el.classList.remove('stg-hidden');
}

function hideVotePrompt() {
    document.getElementById('stg_vote_prompt')?.classList.add('stg-hidden');
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

let ghostName = null;

// The bot's name/avatar come from the host (the guest may not have the
// character loaded), so the streaming preview shows the right identity
// instead of falling back to a system-looking default.
function showGhost(name) {
    removeGhost();
    const chat = document.getElementById('chat');
    if (!chat) return;
    ghostName = name || getCtx().name2 || 'Bot';
    const avatar = state.remoteAvatars[ghostName];
    const ghost = document.createElement('div');
    ghost.id = 'stg_stream';
    ghost.innerHTML = `
        ${avatar ? `<img class="stg-ghost-avatar" src="${avatar}" alt="">` : ''}
        <div class="stg-ghost-body">
            <div class="stg-ghost-name"></div>
            <div class="stg-ghost-text"></div>
        </div>`;
    ghost.querySelector('.stg-ghost-name').textContent = ghostName;
    chat.appendChild(ghost);
    chat.scrollTop = chat.scrollHeight;
}

function updateGhost(text) {
    let ghost = document.getElementById('stg_stream');
    if (!ghost) { showGhost(ghostName); ghost = document.getElementById('stg_stream'); }
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
    const away = state.role === 'guest' && state.hostAway;
    const mine = myTurn() && !away;
    document.getElementById('stg_turn_label').textContent = away
        ? 'Paused: host is in another chat'
        : mine
            ? 'Your turn'
            : `Waiting: ${state.peerName ?? 'other player'}'s turn`;
    bar.classList.toggle('stg-my-turn', mine);
    for (const id of ['stg_continue', 'stg_botreply', 'stg_pass']) {
        document.getElementById(id)?.classList.toggle('disabled', !mine);
    }
    if (textarea) {
        textarea.disabled = !mine;
        textarea.placeholder = away
            ? 'Host is in another chat...'
            : mine ? 'Your turn. Type a message...' : 'Waiting for the other player...';
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
            <div id="stg_voteswipe" class="menu_button" title="Ask the other player to swipe (regenerate) the last response">Vote Swipe</div>
            <div id="stg_continue" class="menu_button" title="Extend the bot's last message">Continue</div>
            <div id="stg_botreply" class="menu_button" title="Bot speaks again without a new message">Bot Reply</div>
            <div id="stg_pass" class="menu_button" title="Hand the turn to the other player">Pass Turn</div>
        </div>
        <div id="stg_vote_prompt" class="stg-hidden stg-vote-prompt">
            <span id="stg_vote_text"></span>
            <div id="stg_vote_agree" class="menu_button">Agree</div>
            <div id="stg_vote_disagree" class="menu_button">Disagree</div>
        </div>`;
    formSheld.prepend(bar);

    const guarded = (kind) => () => {
        if (!myTurn()) return toast('warning', 'Not your turn.');
        wsSend({ t: 'action', kind });
    };
    document.getElementById('stg_continue').addEventListener('click', guarded('continue'));
    document.getElementById('stg_botreply').addEventListener('click', guarded('botreply'));
    document.getElementById('stg_pass').addEventListener('click', guarded('pass'));

    // Vote-to-swipe is cooperative, so it is NOT turn-gated: either player can propose.
    document.getElementById('stg_voteswipe').addEventListener('click', () => {
        if (!state.connected) return;
        wsSend({ t: 'vote', kind: 'request' });
        toast('info', 'Vote sent. Waiting for the other player to agree.');
    });
    document.getElementById('stg_vote_agree').addEventListener('click', () => {
        wsSend({ t: 'vote', kind: 'agree' });
        hideVotePrompt();
    });
    document.getElementById('stg_vote_disagree').addEventListener('click', () => {
        wsSend({ t: 'vote', kind: 'disagree' });
        hideVotePrompt();
    });

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

// Invite is "<sillytavern-origin>#<token>", e.g.
// "https://sagserver.org#K3n9vQ" or "http://192.168.1.5:8000#K3n9vQ".
function parseInvite(raw) {
    const value = String(raw ?? '').trim().replace(/^stg:\/\//i, '');
    const hash = value.lastIndexOf('#');
    if (hash === -1) return null;
    const origin = value.slice(0, hash).replace(/\/+$/, '');
    const token = value.slice(hash + 1).trim();
    if (!/^https?:\/\/[^\s]+$/i.test(origin) || !token) return null;
    return { url: wsUrlForOrigin(origin), token };
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
    const autoPass = document.getElementById('stg_autopass').checked;
    const tunnel = document.getElementById('stg_tunnel').checked;
    s.autoPass = autoPass;
    s.tunnel = tunnel;
    saveSettings();
    setStatus(tunnel ? 'Starting session and Cloudflare tunnel (can take up to a minute on first run) ...' : 'Starting session ...');
    try {
        const response = await fetch('/api/plugins/st-together/start', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ autoPass, tunnel }),
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
        state.session.token = data.token;
        // Guests connect to whichever origin can reach this ST: the public
        // tunnel if enabled, otherwise the same origin this browser is on.
        const inviteOrigin = data.tunnelUrl || window.location.origin;
        document.getElementById('stg_invite_out').value = `${inviteOrigin}#${data.token}`;
        connect(localWsUrl(), data.token, 'host');
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
        toast('error', 'Invalid invite code. Expected something like https://host#token');
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
                    <div class="stg-setting">
                        <label class="checkbox_label"><input id="stg_autopass" type="checkbox" ${s.autoPass ? 'checked' : ''}> Auto-pass turn after bot reply</label>
                        <div class="stg-subtext">Hands the turn back automatically after each bot reply, instead of keeping it until you press Pass Turn.</div>
                    </div>
                    <div class="stg-setting">
                        <label class="checkbox_label"><input id="stg_announce" type="checkbox" ${s.announcePlayers ? 'checked' : ''}> Tell the AI there are multiple players</label>
                        <div class="stg-subtext">Shares each player's persona so the character treats you as distinct people and can address you by name.</div>
                        <div class="stg-advanced">
                            <div id="stg_adv_toggle" class="stg-advanced-toggle"><span class="stg-adv-caret">▸</span> Advanced: view &amp; edit the exact prompt</div>
                            <div id="stg_adv_body" class="stg-advanced-body stg-hidden">
                                <label>Prompt template <span class="stg-subtext-inline">— <code>{{participants}}</code> is replaced with the player list</span>
                                    <textarea id="stg_participants_template" class="text_pole" rows="6">${(s.participantsTemplate || DEFAULT_PARTICIPANTS_TEMPLATE).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</textarea>
                                </label>
                                <div class="stg-row">
                                    <label>Inject
                                        <select id="stg_participants_position" class="text_pole">
                                            <option value="1" ${s.participantsPosition !== 0 ? 'selected' : ''}>in chat, at depth</option>
                                            <option value="0" ${s.participantsPosition === 0 ? 'selected' : ''}>at top of prompt</option>
                                        </select>
                                    </label>
                                    <label id="stg_depth_wrap">Depth
                                        <input id="stg_participants_depth" class="text_pole" type="number" min="0" max="100" value="${Number.isFinite(s.participantsDepth) ? s.participantsDepth : 4}">
                                    </label>
                                    <div id="stg_participants_reset" class="menu_button" title="Restore the default prompt">Reset</div>
                                </div>
                                <label>Live preview <span class="stg-subtext-inline">— exactly what the AI receives</span>
                                    <textarea id="stg_participants_preview" class="text_pole" rows="7" readonly></textarea>
                                </label>
                            </div>
                        </div>
                    </div>
                    <div class="stg-setting">
                        <label class="checkbox_label"><input id="stg_tunnel" type="checkbox" ${s.tunnel ? 'checked' : ''}> Use a temporary public link so friends outside your network can join</label>
                        <div class="stg-subtext">Creates a throwaway address so someone off your network can reach this session. <a href="https://github.com/Izanagi72BB/ST-Together#how-the-temporary-link-works" target="_blank" rel="noopener" class="stg-inline-link">How it works ↗</a></div>
                    </div>
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
                    <div class="stg-subtext">Leave the public link on unless your SillyTavern already has its own public address.</div>
                </div>
                <div id="stg_guest_block" class="${s.role === 'guest' ? '' : 'stg-hidden'}">
                    <label>Invite code
                        <input id="stg_invite_in" class="text_pole" type="text" placeholder="https://host#token" value="${s.lastInvite.replace(/"/g, '&quot;')}">
                    </label>
                    <label class="checkbox_label"><input id="stg_sharepersona" type="checkbox" ${s.sharePersonaDesc ? 'checked' : ''}> Share my Persona with the host's AI</label>
                    <small>The host can't read your Persona description, but their LLM sees it so the character knows who you are (max 2000 characters). Unticked: only your Persona name is shared.</small>
                    <div class="stg-row">
                        <div id="stg_join" class="menu_button">Join</div>
                        <div id="stg_leave" class="menu_button">Leave</div>
                    </div>
                    <small>Open a chat to mirror the session into before joining. A fresh one is safest, since it gets replaced by the host's shared chat.</small>
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
    $('#stg_announce').on('change', function () {
        settings().announcePlayers = this.checked;
        saveSettings();
        updateParticipantsPrompt();
    });
    $('#stg_adv_toggle').on('click', () => {
        const body = document.getElementById('stg_adv_body');
        const open = body.classList.toggle('stg-hidden');
        document.querySelector('.stg-adv-caret').textContent = open ? '▸' : '▾';
        if (!open) refreshParticipantsPreview();
    });
    $('#stg_participants_template').on('input', function () {
        settings().participantsTemplate = this.value;
        saveSettings();
        updateParticipantsPrompt();
    });
    const syncDepthVisibility = () => {
        const pos = Number(document.getElementById('stg_participants_position').value);
        document.getElementById('stg_depth_wrap').classList.toggle('stg-hidden', pos === 0);
    };
    $('#stg_participants_position').on('change', function () {
        settings().participantsPosition = Number(this.value);
        saveSettings();
        syncDepthVisibility();
        updateParticipantsPrompt();
    });
    $('#stg_participants_depth').on('input', function () {
        settings().participantsDepth = Number(this.value) || 0;
        saveSettings();
        updateParticipantsPrompt();
    });
    $('#stg_participants_reset').on('click', () => {
        settings().participantsTemplate = '';
        saveSettings();
        document.getElementById('stg_participants_template').value = DEFAULT_PARTICIPANTS_TEMPLATE;
        updateParticipantsPrompt();
        toast('info', 'Prompt reset to default.');
    });
    syncDepthVisibility();
    refreshParticipantsPreview();
    $('#stg_sharepersona').on('change', function () {
        settings().sharePersonaDesc = this.checked;
        saveSettings();
        sendPersona(); // push the change if already in a session
    });
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
