import React, { useState } from 'react';
import { useGame } from './GameContext';

export default function Home({ onJoin, isConnected = false, prefilledRoomCode = null }) {
    const { configureGame } = useGame();
    const [mode, setMode] = useState(prefilledRoomCode ? 'join' : 'menu');
    const [name, setName] = useState('');
    const [roomCode, setRoomCode] = useState(prefilledRoomCode || '');

    const handleCreate = () => setMode('create_confirm');

    const handleJoinSubmit = (e) => {
        e.preventDefault();
        if (name && roomCode) onJoin(name, roomCode);
    };

    const handleCreateSubmit = (e) => {
        e.preventDefault();
        if (!name) return;
        configureGame({
            words_per_player: parseInt(document.getElementById('wordsPerPlayer').value),
            target_score:     parseInt(document.getElementById('targetScore').value),
            strokes_per_artist: parseInt(document.getElementById('strokesPerArtist').value),
            min_players:      parseInt(document.getElementById('minPlayers').value),
            turn_duration:    0,
        });
        // Create path: leave roomCode empty so the provider routes to handleCreate.
        onJoin(name, '');
    };

    return (
        <div className="card shadow-lg text-center p-4">
            <h1 className="display-5 mb-3 text-primary">Fake Artist</h1>
            <p className="text-muted">A Fake Artist Goes to New York — Web Edition</p>

            {!isConnected && <div className="alert alert-warning py-2">Connecting…</div>}

            {mode === 'menu' && (
                <div className="d-grid gap-3 col-10 col-md-8 mx-auto mt-3">
                    <button className="btn btn-primary btn-lg" onClick={handleCreate} disabled={!isConnected}>Create Game</button>
                    <button className="btn btn-outline-secondary btn-lg" onClick={() => setMode('join')} disabled={!isConnected}>Join Game</button>
                </div>
            )}

            {mode === 'join' && (
                <form onSubmit={handleJoinSubmit} className="text-start mt-3">
                    <h4 className="mb-3">Join Room</h4>
                    <div className="mb-3">
                        <label className="form-label">Room Code</label>
                        <input className="form-control text-uppercase" placeholder="ABCD" value={roomCode} onChange={e => setRoomCode(e.target.value)} required />
                    </div>
                    <div className="mb-3">
                        <label className="form-label">Your Name</label>
                        <input className="form-control" value={name} onChange={e => setName(e.target.value)} required />
                    </div>
                    <div className="d-grid gap-2">
                        <button type="submit" className="btn btn-success">Join</button>
                        <button type="button" className="btn btn-link" onClick={() => setMode('menu')}>Back</button>
                    </div>
                </form>
            )}

            {mode === 'create_confirm' && (
                <form onSubmit={handleCreateSubmit} className="text-start mt-3">
                    <h4 className="mb-3">Configure</h4>
                    <div className="mb-3">
                        <label className="form-label">Your Name</label>
                        <input className="form-control" value={name} onChange={e => setName(e.target.value)} required />
                    </div>
                    <div className="row g-3">
                        <div className="col-6">
                            <label className="form-label">Words per Player</label>
                            <input type="number" className="form-control" id="wordsPerPlayer" defaultValue="3" min="1" max="10" />
                        </div>
                        <div className="col-6">
                            <label className="form-label">Target Score</label>
                            <input type="number" className="form-control" id="targetScore" defaultValue="5" min="1" max="20" />
                        </div>
                        <div className="col-6">
                            <label className="form-label">Strokes per Artist</label>
                            <input type="number" className="form-control" id="strokesPerArtist" defaultValue="2" min="1" max="5" />
                        </div>
                        <div className="col-6">
                            <label className="form-label">Min Players</label>
                            <input type="number" className="form-control" id="minPlayers" defaultValue="4" min="3" max="10" />
                        </div>
                    </div>
                    <div className="d-grid gap-2 mt-4">
                        <button type="submit" className="btn btn-primary btn-lg">Create & Join</button>
                        <button type="button" className="btn btn-link" onClick={() => setMode('menu')}>Back</button>
                    </div>
                </form>
            )}
        </div>
    );
}
