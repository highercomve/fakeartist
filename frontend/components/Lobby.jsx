import React, { useState } from 'react';
import { useGame } from './GameContext';

export default function Lobby() {
    const { gameState, joinGame, startGame, myPlayerId, roomCode } = useGame();
    const [name, setName] = useState('');
    const [copied, setCopied] = useState(false);

    if (!gameState) return <div>Loading…</div>;
    const isAdmin = gameState.host_id && gameState.host_id === myPlayerId;
    const players = gameState.players || [];
    const minPlayers = gameState.config?.min_players ?? 4;

    const inviteUrl = roomCode && typeof window !== 'undefined'
        ? `${window.location.origin}/room/${roomCode}`
        : '';

    const copyInvite = async () => {
        if (!inviteUrl) return;
        try { await navigator.clipboard.writeText(inviteUrl); }
        catch { /* fall back to a no-op; user can still read it */ }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };

    return (
        <div className="card shadow-sm">
            <div className="card-body">
                <div className="text-center mb-4">
                    <h2 className="card-title">Lobby</h2>
                    {roomCode && (
                        <>
                            <h4 className="text-primary font-monospace">
                                Room: <span className="badge bg-primary">{roomCode}</span>
                            </h4>
                            <div className="input-group input-group-sm mt-2" style={{maxWidth: 480, margin: '0 auto'}}>
                                <input readOnly className="form-control text-center" value={inviteUrl} />
                                <button className="btn btn-outline-primary" onClick={copyInvite}>
                                    {copied ? 'Copied!' : 'Copy invite link'}
                                </button>
                            </div>
                        </>
                    )}
                </div>

                {!myPlayerId ? (
                    <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) joinGame(name); }} className="mb-4">
                        <div className="input-group">
                            <input className="form-control" placeholder="Your name" value={name} onChange={e => setName(e.target.value)} />
                            <button className="btn btn-primary" type="submit">Join</button>
                        </div>
                    </form>
                ) : (
                    !isAdmin && <div className="alert alert-success text-center">Waiting for host…</div>
                )}

                <h5>Players ({players.length})</h5>
                <ul className="list-group mb-3">
                    {players.map(p => (
                        <li key={p.id} className="list-group-item d-flex align-items-center">
                            <span className="me-2 d-inline-block rounded-circle border" style={{width:20, height:20, background:p.color}}></span>
                            <span className="flex-grow-1">
                                {p.name}
                                {p.id === myPlayerId && <span className="text-muted small"> (you)</span>}
                                {p.id === gameState.host_id && <span className="ms-2">👑</span>}
                                {!p.connected && <span className="ms-2 badge bg-secondary">offline</span>}
                            </span>
                        </li>
                    ))}
                    {players.length === 0 && <li className="list-group-item text-muted">No players yet</li>}
                </ul>

                {isAdmin && (
                    <div className="d-grid gap-2 mt-3">
                        <button
                            className="btn btn-warning btn-lg"
                            disabled={players.length < minPlayers}
                            onClick={startGame}
                        >
                            Start Game {players.length < minPlayers && `(need ${minPlayers - players.length} more)`}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
