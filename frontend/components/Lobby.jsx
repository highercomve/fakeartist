import React, { useState } from 'react';
import { useGame } from './GameContext';

export default function Lobby() {
    const { gameState, joinGame, startGame, myPlayerId } = useGame();
    const [name, setName] = useState('');

    if (!gameState) return <div>Loading…</div>;
    const isAdmin = gameState.host_id && gameState.host_id === myPlayerId;
    const players = gameState.players || [];
    const minPlayers = gameState.config?.min_players ?? 4;

    return (
        <div className="card shadow-sm">
            <div className="card-body">
                <div className="text-center mb-4">
                    <h2 className="card-title">Lobby</h2>
                    <h4 className="text-primary font-monospace">
                        Room: <span className="badge bg-primary">{gameState.id}</span>
                    </h4>
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
