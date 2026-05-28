import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GameContext } from './GameContext';
import { Engine } from '../p2p/engine';
import { LoopbackTransport, RTCTransport, RelayTransport } from '../p2p/transport';
import { Replica } from '../p2p/replica';
import { SignalingClient } from '../p2p/signaling';
import { PeerHub } from '../p2p/peerHub';
import { HostBridge } from '../p2p/hostBridge';
import { StrokeLog } from '../p2p/log';
import { CheckpointDispatcher } from '../p2p/checkpoint';
import { HttpRoleDrawer } from '../p2p/engineHttp';
import { elect } from '../p2p/election';
import Home from './Home';
import Lobby from './Lobby';
import WordInput from './WordInput';
import RoundAnnounce from './RoundAnnounce';
import DrawCanvas from './DrawCanvas';
import Voting from './Voting';
import FakeGuess from './FakeGuess';
import RoundSummary from './RoundSummary';
import GameOver from './GameOver';

// P2pGameProvider: the host/guest-branching provider mounted at /p2p.
//
// Lifecycle:
//   1) User submits name + (optional) room code on Home.
//   2) We POST /api/rooms (create) or POST /api/rooms/:code/join. The
//      response tells us role + (room_id, player_id, host_id).
//   3) We open SignalingClient and PeerHub.
//   4) If host: spawn Engine + HostBridge + LoopbackTransport.
//   5) If guest: open RTCTransport against the host's DC.
//   6) On HOST_CHANGED or cold-boot "no host" we follow §7.3 (T7.3).
//
// All UI components keep reading from the same GameContext value shape
// as the legacy provider.

const STORAGE_KEY_ID = 'fakeartist_p2p_playerId';
const STORAGE_KEY_ROOM = 'fakeartist_p2p_roomCode';

function buildSignalUrl(roomId, playerId) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/api/signal?room=${roomId}&player=${playerId}`;
}

async function postJSON(path, body) {
    const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`${res.status}: ${text}`);
    }
    return res.json();
}

async function lookupRoom(code) {
    const res = await fetch(`/api/rooms/${code}`);
    if (!res.ok) throw new Error(`lookup ${res.status}`);
    return res.json();
}

// Parse `/room/CODE` out of the path so a shared link auto-prefills the
// join form. Anything else returns null and Home shows the menu.
function parseRoomCodeFromPath() {
    if (typeof window === 'undefined') return null;
    const m = window.location.pathname.match(/^\/room\/([A-Za-z0-9]+)/);
    return m ? m[1].toUpperCase() : null;
}

export default function P2pGameProvider() {
    // session state we mirror into context
    const [snapshot, setSnapshot] = useState({ state: null, myId: null, myRole: null });
    const [errorMsg, setErrorMsg] = useState(null);
    const [isConnected, setIsConnected] = useState(false);
    const [mode, setMode] = useState('idle'); // 'idle' | 'host' | 'guest'
    const [roomCode, setRoomCode] = useState(null);
    const prefilledRoomCode = parseRoomCodeFromPath();

    // imperative session refs
    const refs = useRef({
        roomId: null,
        roomCode: null,
        playerId: null,
        hostId: null,
        engine: null,
        replica: null,
        transport: null,
        bridge: null,
        peerHub: null,
        signaling: null,
        log: null,
        checkpoint: null,
        // For guests, the dc against the host once it opens.
        hostDc: null,
        // Live signaling-derived membership (T8.2): updated by PEER_JOINED
        // / PEER_LEFT. Used both for the host's connectTo loop and for the
        // failover election.
        connected: new Set(),
        // Grace timer handle (failover). null when no host-death pending.
        failoverTimer: null,
        // Pending configuration applied once transport is ready.
        pendingConfig: null,
        // listeners we'll need to clean up.
        unsub: [],
    });
    const strokeListenersRef = useRef([]);

    const cleanup = () => {
        const r = refs.current;
        if (r.failoverTimer) { clearTimeout(r.failoverTimer); r.failoverTimer = null; }
        r.unsub.forEach((fn) => { try { fn(); } catch { /* noop */ } });
        r.unsub = [];
        try { r.transport?.close(); } catch { /* noop */ }
        try { r.bridge?.close?.(); } catch { /* noop */ }
        try { r.peerHub?.close?.(); } catch { /* noop */ }
        try { r.signaling?.close?.(); } catch { /* noop */ }
        try { r.checkpoint?.close?.(); } catch { /* noop */ }
        r.transport = r.bridge = r.peerHub = r.signaling = r.engine = r.log = r.checkpoint = null;
        r.hostDc = null;
    };

    // tearDownGuestStack closes only the guest-side transport+peerHub
    // but keeps the signaling client alive — used when this peer is
    // promoted to host without dropping its room presence.
    const tearDownGuestStack = () => {
        const r = refs.current;
        try { r.transport?.close(); } catch { /* noop */ }
        try { r.peerHub?.close?.(); } catch { /* noop */ }
        r.transport = null;
        r.peerHub = null;
        r.hostDc = null;
    };

    // runHostFailover (T8.2): the grace window has elapsed and the host
    // is still gone. Run the election against the local view; if we win,
    // POST claim-host. The server's HOST_CHANGED broadcast does the
    // actual promotion via onHostChanged → promoteSelfToHost.
    const runHostFailover = async () => {
        const r = refs.current;
        r.failoverTimer = null;
        // Local view: replica's lastVersion / lastStrokeIndex are the
        // only deterministic signal we can rely on. Peers' floors aren't
        // gossiped today, so they default to (0,0) in election.ts and
        // the server's claim-host arbitration breaks any ties we miss.
        const snap = r.replica?.snapshot ?? { lastVersion: 0, lastStrokeIndex: 0 };
        const connected = Array.from(r.connected).filter((id) => id !== r.hostId);
        if (!connected.includes(r.playerId)) connected.push(r.playerId);
        const winner = elect({
            selfId: r.playerId,
            selfVersion: snap.lastVersion,
            selfLastStrokeIndex: snap.lastStrokeIndex,
            connected,
        });
        if (winner !== r.playerId) return; // someone else will claim.
        try {
            const res = await fetch(`/api/rooms/${r.roomId}/claim-host`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    player_id: r.playerId,
                    version: snap.lastVersion,
                    last_stroke_index: snap.lastStrokeIndex,
                }),
            });
            // On endorsement the server has already broadcast HOST_CHANGED;
            // the wireGuest signaling handler picks it up and promotes.
            // 409 = lost arbitration; we silently demote and wait for the
            // winner's HOST_CHANGED.
            if (!res.ok && res.status !== 409) {
                setErrorMsg(`Claim-host failed (${res.status})`);
            }
        } catch (e) {
            setErrorMsg(`Claim-host error: ${e.message}`);
        }
    };

    // scheduleFailover starts the 3–8s randomized grace timer when the
    // host's PEER_LEFT arrives. Jitter prevents the thundering-herd
    // claim storm described in plan §14.
    const scheduleFailover = () => {
        const r = refs.current;
        if (r.failoverTimer) return; // already armed
        const jitter = 3000 + Math.floor(Math.random() * 5000);
        r.failoverTimer = setTimeout(() => { void runHostFailover(); }, jitter);
    };
    const cancelFailover = () => {
        const r = refs.current;
        if (r.failoverTimer) { clearTimeout(r.failoverTimer); r.failoverTimer = null; }
    };

    // promoteSelfToHost (T8.4): tear down the guest stack and bring up
    // the host stack seeded from the local replica's latest state.
    // Called when HOST_CHANGED arrives and identifies us as the new host.
    const promoteSelfToHost = async () => {
        const r = refs.current;
        const seedState = r.replica?.snapshot?.state ?? null;
        const seedVersion = r.replica?.snapshot?.lastVersion ?? 0;
        tearDownGuestStack();
        await wireHost(r.roomId, r.playerId, { keepSignaling: true, seedState, seedVersion });
    };

    useEffect(() => () => cleanup(), []);

    // -- host setup --
    // opts.keepSignaling reuses the existing signaling client + presence
    // set on host-promotion (T8.4) so we don't churn the WS.
    // opts.seedState seeds the engine from the local replica's last
    // observed state (so the new host resumes the round rather than
    // restarting it from LOBBY).
    const wireHost = async (roomId, playerId, opts = {}) => {
        const r = refs.current;
        r.roomId = roomId;
        r.playerId = playerId;
        r.hostId = playerId;

        const log = new StrokeLog({ roomId });
        const drawer = new HttpRoleDrawer({ playerId });
        const engine = new Engine(roomId, { config: {}, drawer });
        if (opts.seedState) {
            // T8.4: rebuild the engine from the local replica's last
            // observed state so the new host can keep broadcasting from
            // the same (round, stroke_index).
            try {
                engine.state = JSON.parse(JSON.stringify(opts.seedState));
                engine.version = opts.seedVersion || 0;
                // The seeded state was sanitized (the host saw the
                // STATE_UPDATE as a peer). fake_id, card_id, and the
                // round's revealed_word are missing. We can't recover
                // them without /reveal, but for vote tally we need
                // fake_id — best effort: leave as empty string and
                // accept that the in-flight round may not finalize
                // cleanly. Documented limitation in §7.3 carry-over.
            } catch { /* noop */ }
        }
        const replica = new Replica();
        const transport = new LoopbackTransport({ engine, selfPlayerId: playerId });
        const sig = opts.keepSignaling && r.signaling
            ? r.signaling
            : new SignalingClient({ url: buildSignalUrl(roomId, playerId), role: 'host' });
        const peerHub = new PeerHub({
            selfId: playerId,
            send: {
                sendOffer: (to, sdp) => sig.send({ type: 'SDP_OFFER', to, sdp }),
                sendAnswer: (to, sdp) => sig.send({ type: 'SDP_ANSWER', to, sdp }),
                sendIce: (to, candidate) => sig.send({ type: 'ICE', to, candidate }),
            },
        });
        const bridge = new HostBridge({ engine, peerHub, log });
        const checkpoint = new CheckpointDispatcher({ roomId, hostId: playerId, engine, log });

        // T9.2 host side: track guests that have fallen back to the
        // server-relay path. We mirror engine broadcasts to them as
        // RELAY frames in addition to the DC fan-out (which no-ops
        // for them since no DC exists).
        const relayPeers = new Set();
        r.unsub.push(engine.onBroadcast((evt) => {
            if (relayPeers.size === 0) return;
            const round = engine.state.current_round;
            let frame;
            if (evt.type === 'STATE_UPDATE') {
                frame = { t: 'STATE_UPDATE', version: engine.version, state: evt.payload };
            } else if (evt.type === 'STROKE_ADDED') {
                frame = { t: 'STROKE_ADDED', round_index: round ? round.index : 0, stroke_index: evt.payload.stroke_index, stroke: evt.payload.stroke };
            } else {
                return;
            }
            for (const pid of relayPeers) {
                sig.send({ type: 'RELAY', to: pid, envelope: frame });
            }
        }));
        r.unsub.push(engine.onDirect((pid, evt) => {
            if (!relayPeers.has(pid)) return;
            const round = engine.state.current_round;
            let frame = null;
            if (evt.type === 'PLAYER_WELCOME') frame = { t: 'PLAYER_WELCOME', payload: evt.payload };
            else if (evt.type === 'YOUR_ROLE') frame = { t: 'YOUR_ROLE', round_index: round ? round.index : 0, payload: evt.payload };
            else if (evt.type === 'ERROR') frame = { t: 'ERROR', message: evt.payload.message };
            if (frame) sig.send({ type: 'RELAY', to: pid, envelope: frame });
        }));

        // Host initiates SDP offer to each guest as they're discovered.
        r.unsub.push(sig.onMessage(async (env) => {
            if (env.type === 'PEER_JOINED' && env.player_id !== playerId) {
                r.connected.add(env.player_id);
                try { await peerHub.connectTo(env.player_id); } catch { /* noop */ }
            } else if (env.type === 'PEER_LEFT') {
                r.connected.delete(env.player_id);
                peerHub.closePeer(env.player_id);
            } else if (env.type === 'SDP_OFFER') {
                await peerHub.acceptOffer(env.from, env.sdp);
            } else if (env.type === 'SDP_ANSWER') {
                await peerHub.addRemoteAnswer(env.from, env.sdp);
            } else if (env.type === 'ICE') {
                await peerHub.addRemoteIce(env.from, env.candidate);
            } else if (env.type === 'YOUR_ROLE') {
                // T6.3: server-dispatched role envelope (DM via signaling).
                replica.apply({ type: 'YOUR_ROLE', payload: env.payload });
            } else if (env.type === 'RELAY') {
                // T9.2: a guest is using the server-relay fallback.
                // Dispatch the inner envelope into the engine the same
                // way HostBridge handles inbound DC frames. Outbound
                // events back to that guest go via RELAY too — we wrap
                // them when peerHub.send misses (no DC open).
                relayPeers.add(env.from);
                const inner = env.envelope;
                if (inner && inner.t === 'CMD' && inner.cmd) {
                    engine.dispatch(inner.cmd, env.from);
                } else if (inner && inner.t === 'SYNC_REQ') {
                    // Serve sync over relay: build SYNC_RES like
                    // HostBridge does and ship via signaling.
                    const round = engine.state.current_round;
                    const strokes = round && round.index === inner.round_index
                        ? round.strokes.slice(inner.from_stroke_index).map((s, i) => ({
                            round_index: round.index,
                            stroke_index: inner.from_stroke_index + i,
                            stroke: s,
                        }))
                        : [];
                    sig.send({
                        type: 'RELAY',
                        to: env.from,
                        envelope: {
                            t: 'SYNC_RES',
                            state: engine.state,
                            version: engine.version,
                            strokes,
                        },
                    });
                }
            } else if (env.type === 'HOST_CHANGED') {
                // We're already host. If someone else claimed (e.g. our
                // original promotion lost arbitration), demote.
                if (env.player_id !== playerId) {
                    r.hostId = env.player_id;
                    // graceful demotion: tear down host stack and
                    // re-enter as guest against the new host.
                    setErrorMsg('Demoted: another peer is the new host');
                    tearDownGuestStack();
                    try { r.bridge?.close?.(); } catch { /* noop */ }
                    try { r.checkpoint?.close?.(); } catch { /* noop */ }
                    try { r.transport?.close(); } catch { /* noop */ }
                    r.bridge = r.checkpoint = r.transport = null;
                    await wireGuest(roomId, playerId, env.player_id, { keepSignaling: true });
                }
            }
        }));
        r.unsub.push(sig.onStatus((s) => setIsConnected(s === 'open')));

        // replica receives engine events through the loopback transport.
        r.unsub.push(transport.onEvent((evt) => replica.apply(evt)));
        r.unsub.push(replica.onChange((s) => setSnapshot({ ...s })));
        r.unsub.push(replica.onStroke((p) => strokeListenersRef.current.forEach((fn) => fn(p))));
        r.unsub.push(replica.onError((m) => { setErrorMsg(m); setTimeout(() => setErrorMsg(null), 4000); }));

        // checkpoint dispatcher listens to the engine directly.
        checkpoint.start();

        r.engine = engine;
        r.replica = replica;
        r.transport = transport;
        r.bridge = bridge;
        r.peerHub = peerHub;
        r.signaling = sig;
        r.log = log;
        r.checkpoint = checkpoint;
        setMode('host');

        // Auto-join the engine as the host player. JOIN must precede
        // CONFIGURE — handleConfigure gates on requireHost, which only
        // passes once state.host_id is set by the first JOIN.
        transport.send({ type: 'JOIN_GAME', payload: { id: playerId, player_name: localStorage.getItem('fakeartist_name') || 'Host' } });
        if (r.pendingConfig) {
            transport.send({ type: 'CONFIGURE_GAME', payload: r.pendingConfig });
            r.pendingConfig = null;
        }

        // On promotion (keepSignaling=true) the new host already has a
        // set of `connected` peers from its prior guest-mode signaling
        // session. The signaling server won't replay PEER_JOINED for
        // those, so we have to initiate SDP offers ourselves for each.
        if (opts.keepSignaling) {
            for (const pid of r.connected) {
                if (pid === playerId) continue;
                peerHub.connectTo(pid).catch(() => { /* noop */ });
            }
        }
    };

    // -- guest setup --
    const wireGuest = async (roomId, playerId, hostId, opts = {}) => {
        const r = refs.current;
        r.roomId = roomId;
        r.playerId = playerId;
        r.hostId = hostId;

        // Existing replica is kept across promotion-demotion cycles when
        // re-entering guest mode so we don't lose the local floor.
        const reuseReplica = opts.keepSignaling && r.replica;
        const replica = reuseReplica
            ? r.replica
            : new Replica({
                requestSync: (round, fromIdx) => {
                    if (!r.hostDc || r.hostDc.readyState !== 'open') return;
                    r.hostDc.send(JSON.stringify({ t: 'SYNC_REQ', round_index: round, from_stroke_index: fromIdx }));
                },
            });
        const sig = opts.keepSignaling && r.signaling
            ? r.signaling
            : new SignalingClient({ url: buildSignalUrl(roomId, playerId), role: 'guest' });
        const peerHub = new PeerHub({
            selfId: playerId,
            send: {
                sendOffer: (to, sdp) => sig.send({ type: 'SDP_OFFER', to, sdp }),
                sendAnswer: (to, sdp) => sig.send({ type: 'SDP_ANSWER', to, sdp }),
                sendIce: (to, candidate) => sig.send({ type: 'ICE', to, candidate }),
            },
        });

        // T9.2: ICE timeout — if the DC hasn't opened, fall back to a
        // RelayTransport over the signaling WS. Cellular NAT (esp. iOS)
        // makes STUN-only ICE fail reliably, so we don't wait long.
        let iceTimeoutHandle = setTimeout(() => {
            if (r.transport) return; // DC opened in time
            console.log('[p2p] ICE timeout, falling back to server relay');
            // Fall back. The relay transport sends RELAY-wrapped
            // envelopes addressed to the host.
            const relay = new RelayTransport({
                sendRelay: (relayEnv) => sig.send({ type: 'RELAY', to: r.hostId, envelope: relayEnv }),
            });
            r.transport = relay;
            r.unsub.push(relay.onEvent((evt) => replica.apply(evt)));
            // Best-effort handshake JOIN over relay.
            relay.send({
                type: 'JOIN_GAME',
                payload: { id: playerId, player_name: localStorage.getItem('fakeartist_name') || 'Guest' },
            });
            // Kick a SYNC_REQ — though without a hostDc, the replica's
            // requestSync hook will be a no-op. Instead the host will
            // emit STATE_UPDATE on next change and the replica picks up.
            setErrorMsg('Connecting via server (slower mode)');
            setTimeout(() => setErrorMsg(null), 3000);
        }, 4000);
        r.unsub.push(() => clearTimeout(iceTimeoutHandle));

        // Guests wait for the host to initiate the offer.
        r.unsub.push(sig.onMessage(async (env) => {
            if (env.type === 'PEER_JOINED') {
                r.connected.add(env.player_id);
                // If a *host* PEER_JOINED arrives after our own grace
                // timer was scheduled, the host came back — cancel
                // the failover.
                if (env.player_id === r.hostId) cancelFailover();
            } else if (env.type === 'SDP_OFFER') {
                try { await peerHub.acceptOffer(env.from, env.sdp); }
                catch (e) { console.error('[p2p] acceptOffer failed:', e); }
            } else if (env.type === 'SDP_ANSWER') {
                try { await peerHub.addRemoteAnswer(env.from, env.sdp); }
                catch (e) { console.error('[p2p] addRemoteAnswer failed:', e); }
            } else if (env.type === 'ICE') {
                try { await peerHub.addRemoteIce(env.from, env.candidate); }
                catch (e) { console.error('[p2p] addRemoteIce failed:', e); }
            } else if (env.type === 'YOUR_ROLE') {
                replica.apply({ type: 'YOUR_ROLE', payload: env.payload });
            } else if (env.type === 'RELAY') {
                // T9.2: inbound DC envelope via the server relay path.
                // Route through the active transport if it's RelayTransport;
                // otherwise the DC opened and we ignore (host shouldn't
                // be sending both relay and DC at the same time).
                if (r.transport && r.transport instanceof RelayTransport) {
                    r.transport.handleRelayIn(env.envelope);
                } else {
                    console.warn('[p2p] dropped RELAY frame: no relay transport active');
                }
            } else if (env.type === 'PEER_LEFT') {
                r.connected.delete(env.player_id);
                if (env.player_id === r.hostId) {
                    // T8.2: host died. Schedule election after the
                    // jittered 3–8s grace window. If the host comes
                    // back inside that window (PEER_JOINED above), the
                    // timer is cancelled. Otherwise runHostFailover()
                    // evaluates the election and possibly POSTs claim.
                    setErrorMsg('Host disconnected — electing new host');
                    scheduleFailover();
                }
            } else if (env.type === 'HOST_CHANGED') {
                // T8.4: server has endorsed a new host. If it's us,
                // promote; otherwise rebind to the new host and reset
                // the DC against the new host.
                cancelFailover();
                if (env.player_id === r.playerId) {
                    setErrorMsg(null);
                    await promoteSelfToHost();
                } else {
                    r.hostId = env.player_id;
                    setErrorMsg(null);
                    // Old DC is dead anyway — wait for new host's SDP
                    // offer. The replica will resync via SYNC_REQ once
                    // the new DC opens.
                    r.hostDc = null;
                }
            }
        }));
        r.unsub.push(sig.onStatus((s) => setIsConnected(s === 'open')));

        r.unsub.push(peerHub.onPeerOpen((peerId, dc) => {
            if (peerId !== r.hostId) return;
            clearTimeout(iceTimeoutHandle);
            r.hostDc = dc;
            const transport = new RTCTransport({
                channel: dc,
                onFrame: (env) => replica.applyFrame(env),
            });
            r.transport = transport;
            r.unsub.push(transport.onEvent((evt) => replica.apply(evt)));
            // Best-effort handshake JOIN.
            transport.send({
                type: 'JOIN_GAME',
                payload: { id: playerId, player_name: localStorage.getItem('fakeartist_name') || 'Guest' },
            });
            // Kick a SYNC_REQ in case we missed strokes pre-DC-open.
            replica.requestSync();
        }));

        if (!reuseReplica) {
            r.unsub.push(replica.onChange((s) => setSnapshot({ ...s })));
            r.unsub.push(replica.onStroke((p) => strokeListenersRef.current.forEach((fn) => fn(p))));
            r.unsub.push(replica.onError((m) => { setErrorMsg(m); setTimeout(() => setErrorMsg(null), 4000); }));
        }

        r.replica = replica;
        r.peerHub = peerHub;
        r.signaling = sig;
        setMode('guest');
    };

    // -- public lobby actions --
    const handleCreate = async (playerName) => {
        try {
            localStorage.setItem('fakeartist_name', playerName);
            const out = await postJSON('/api/rooms', { player_name: playerName });
            localStorage.setItem(STORAGE_KEY_ID, out.player_id);
            localStorage.setItem(STORAGE_KEY_ROOM, out.room_code);
            setRoomCode(out.room_code);
            if (typeof window !== 'undefined' && window.history) {
                window.history.replaceState(null, '', `/room/${out.room_code}`);
            }
            await wireHost(out.room_id, out.player_id);
        } catch (e) {
            setErrorMsg(`Create failed: ${e.message}`);
        }
    };

    const handleJoin = async (playerName, code) => {
        try {
            localStorage.setItem('fakeartist_name', playerName);
            // Lookup first: cold-boot recovery (T7.3) — if the room exists
            // and has no host, we adopt host via claim-host.
            const info = await lookupRoom(code);
            if (!info.exists) { setErrorMsg('Room not found'); return; }
            const out = await postJSON(`/api/rooms/${code}/join`, { player_name: playerName });
            localStorage.setItem(STORAGE_KEY_ID, out.player_id);
            localStorage.setItem(STORAGE_KEY_ROOM, code);
            setRoomCode(code);
            // Cold-boot path: room exists but no host id assigned.
            if (!info.host_id || info.host_id === '') {
                try {
                    const snap = await fetch(`/api/rooms/${out.room_id}/snap`);
                    if (snap.ok) {
                        // The seed state will be re-applied once Engine boots.
                        const claim = await postJSON(`/api/rooms/${out.room_id}/claim-host`, {
                            player_id: out.player_id, version: 0, last_stroke_index: 0,
                        });
                        if (claim.endorsed) {
                            await wireHost(out.room_id, out.player_id);
                            // Seed engine with snapshot state.
                            try {
                                const body = await snap.json();
                                if (body.state) {
                                    refs.current.engine.state = JSON.parse(body.state);
                                    refs.current.engine.version = body.version || 0;
                                }
                            } catch { /* noop */ }
                            return;
                        }
                    }
                } catch { /* fall through to guest */ }
            }
            await wireGuest(out.room_id, out.player_id, info.host_id);
        } catch (e) {
            setErrorMsg(`Join failed: ${e.message}`);
        }
    };

    const sendCmd = (type, payload = {}) => {
        const r = refs.current;
        if (!r.transport) {
            if (type === 'CONFIGURE_GAME') r.pendingConfig = payload;
            return;
        }
        r.transport.send({ type, payload });
    };

    const value = useMemo(() => ({
        gameState: snapshot.state,
        isConnected,
        myPlayerId: snapshot.myId,
        myRole: snapshot.myRole,
        errorMsg,
        roomCode,
        joinGame: (playerName, code) => {
            if (code) handleJoin(playerName, code);
            else handleCreate(playerName);
        },
        configureGame: (c) => sendCmd('CONFIGURE_GAME', c),
        submitWords: (words) => sendCmd('SUBMIT_WORDS', { words }),
        startGame: () => sendCmd('START_GAME'),
        startRound: () => sendCmd('START_ROUND'),
        submitStroke: (points) => sendCmd('SUBMIT_STROKE', { points }),
        castVote: (suspectId) => sendCmd('CAST_VOTE', { suspect_id: suspectId }),
        submitFakeGuess: (guess) => sendCmd('SUBMIT_FAKE_GUESS', { guess }),
        nextRound: () => sendCmd('NEXT_ROUND'),
        endGame: () => sendCmd('END_GAME'),
        onStroke: (fn) => {
            strokeListenersRef.current.push(fn);
            return () => { strokeListenersRef.current = strokeListenersRef.current.filter((f) => f !== fn); };
        },
    }), [snapshot, errorMsg, isConnected, roomCode]);

    let view;
    if (mode === 'idle' || !snapshot.state) {
        view = <Home
            onJoin={(name, room) => value.joinGame(name, room)}
            isConnected={mode === 'idle' ? true : isConnected}
            prefilledRoomCode={prefilledRoomCode}
        />;
    } else {
        switch (snapshot.state.status) {
            case 'LOBBY': view = <Lobby />; break;
            case 'WRITING': view = <WordInput />; break;
            case 'ROUND_ANNOUNCE': view = <RoundAnnounce />; break;
            case 'DRAWING': view = <DrawCanvas />; break;
            case 'VOTING': view = <Voting />; break;
            case 'FAKE_GUESS': view = <FakeGuess />; break;
            case 'ROUND_SUMMARY': view = <RoundSummary />; break;
            case 'GAME_OVER': view = <GameOver />; break;
            default: view = <div>Unknown status: {snapshot.state.status}</div>;
        }
    }

    return (
        <GameContext.Provider value={value}>
            <div className="container py-3" style={{ maxWidth: 720 }}>
                <div className="d-flex justify-content-between align-items-center mb-3">
                    <span className="badge bg-info text-dark">P2P {mode === 'host' ? 'HOST' : mode === 'guest' ? 'GUEST' : ''}</span>
                    {refs.current.roomCode && <span className="badge bg-secondary">Room: {refs.current.roomCode}</span>}
                </div>
                {errorMsg && <div className="alert alert-danger">{errorMsg}</div>}
                {view}
            </div>
        </GameContext.Provider>
    );
}
