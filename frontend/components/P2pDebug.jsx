import React, { useEffect, useRef, useState } from 'react';
import { SignalingClient } from '../p2p/signaling';
import { PeerHub } from '../p2p/peerHub';

// Two-tab smoke test page.
//
// Open in two browser tabs. In tab A click "Create Room", then copy the
// Room ID into tab B and click "Join". The host tab also needs to click
// "Connect to <guestId>" once it sees a PEER_JOINED event so it kicks off
// the SDP offer.
//
// This page intentionally does not use GameContext — it exercises only
// the raw signaling + DataChannel plumbing.

export default function P2pDebug() {
    const [log, setLog] = useState([]);
    const [roomCode, setRoomCode] = useState('');
    const [roomId, setRoomId] = useState('');
    const [playerId, setPlayerId] = useState('');
    const [role, setRole] = useState('host');
    const [name, setName] = useState('Tester');
    const [peers, setPeers] = useState({});
    const [chatIn, setChatIn] = useState('');
    const sigRef = useRef(null);
    const hubRef = useRef(null);

    const append = (s) => setLog((l) => [...l, `[${new Date().toLocaleTimeString()}] ${s}`]);

    const startSignaling = (rId, pId, r) => {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${proto}//${window.location.host}/api/signal?room=${rId}&player=${pId}`;
        const sig = new SignalingClient({ url, role: r });
        sigRef.current = sig;

        const hub = new PeerHub({
            selfId: pId,
            send: {
                sendOffer: (to, sdp) => sig.send({ type: 'SDP_OFFER', to, sdp }),
                sendAnswer: (to, sdp) => sig.send({ type: 'SDP_ANSWER', to, sdp }),
                sendIce: (to, candidate) => sig.send({ type: 'ICE', to, candidate }),
            },
        });
        hubRef.current = hub;

        hub.onPeerOpen((peerId, dc) => {
            append(`DC OPEN with ${peerId}`);
            setPeers((m) => ({ ...m, [peerId]: 'open' }));
        });
        hub.onPeerClose((peerId) => {
            append(`DC CLOSE with ${peerId}`);
            setPeers((m) => { const c = { ...m }; delete c[peerId]; return c; });
        });
        hub.onPeerMessage((peerId, data) => {
            append(`<- ${peerId}: ${data}`);
        });

        sig.onStatus((s) => append(`signal status: ${s}`));
        sig.onMessage(async (env) => {
            append(`signal: ${env.type} ${JSON.stringify(env).slice(0, 80)}`);
            if (env.type === 'PEER_JOINED' && env.player_id !== pId) {
                setPeers((m) => ({ ...m, [env.player_id]: 'discovered' }));
            } else if (env.type === 'PEER_LEFT') {
                setPeers((m) => { const c = { ...m }; delete c[env.player_id]; return c; });
            } else if (env.type === 'SDP_OFFER') {
                await hub.acceptOffer(env.from, env.sdp);
            } else if (env.type === 'SDP_ANSWER') {
                await hub.addRemoteAnswer(env.from, env.sdp);
            } else if (env.type === 'ICE') {
                await hub.addRemoteIce(env.from, env.candidate);
            }
        });
    };

    const handleCreate = async () => {
        const res = await fetch('/api/rooms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ player_name: name }),
        });
        const data = await res.json();
        setRoomCode(data.room_code);
        setRoomId(data.room_id);
        setPlayerId(data.player_id);
        setRole('host');
        append(`created room ${data.room_code} (${data.room_id}) as ${data.player_id}`);
        startSignaling(data.room_id, data.player_id, 'host');
    };

    const handleJoin = async () => {
        const res = await fetch(`/api/rooms/${roomCode}/join`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ player_name: name }),
        });
        if (!res.ok) { append(`join failed: ${res.status}`); return; }
        const data = await res.json();
        setRoomId(data.room_id);
        setPlayerId(data.player_id);
        setRole('guest');
        append(`joined room ${roomCode} -> ${data.room_id} as ${data.player_id}`);
        startSignaling(data.room_id, data.player_id, 'guest');
    };

    const handleConnect = async (peerId) => {
        if (!hubRef.current) return;
        append(`-> initiating offer to ${peerId}`);
        await hubRef.current.connectTo(peerId);
    };

    const handleChat = () => {
        if (!hubRef.current || !chatIn) return;
        hubRef.current.broadcast({ t: 'CHAT', text: chatIn });
        append(`-> broadcast: ${chatIn}`);
        setChatIn('');
    };

    useEffect(() => () => {
        sigRef.current?.close();
        hubRef.current?.close();
    }, []);

    return (
        <div className="container py-3" style={{ maxWidth: 720 }}>
            <h3>P2P Debug</h3>
            <div className="row g-2 mb-3">
                <div className="col-6"><input className="form-control" placeholder="name" value={name} onChange={(e) => setName(e.target.value)} /></div>
                <div className="col-3"><button className="btn btn-primary w-100" onClick={handleCreate}>Create Room</button></div>
            </div>
            <div className="row g-2 mb-3">
                <div className="col-3"><input className="form-control" placeholder="ROOM" value={roomCode} onChange={(e) => setRoomCode(e.target.value.toUpperCase())} /></div>
                <div className="col-5"><input className="form-control" placeholder="player_id (paste host's)" value={playerId} onChange={(e) => setPlayerId(e.target.value)} /></div>
                <div className="col-3"><button className="btn btn-outline-primary w-100" onClick={handleJoin}>Join</button></div>
            </div>
            <div className="mb-2"><small>role: {role} · roomId: {roomId} · playerId: {playerId}</small></div>

            <h5>Peers</h5>
            <ul>
                {Object.entries(peers).map(([pid, status]) => (
                    <li key={pid}>
                        {pid} — {status}
                        {status === 'discovered' && role === 'host' && (
                            <button className="btn btn-sm btn-link" onClick={() => handleConnect(pid)}>Connect</button>
                        )}
                    </li>
                ))}
            </ul>

            <div className="input-group mb-3">
                <input className="form-control" value={chatIn} onChange={(e) => setChatIn(e.target.value)} placeholder="broadcast message" />
                <button className="btn btn-success" onClick={handleChat}>Send</button>
            </div>

            <pre style={{ height: 240, overflow: 'auto', background: '#222', color: '#0f0', padding: 8, fontSize: 12 }}>
                {log.join('\n')}
            </pre>
        </div>
    );
}
