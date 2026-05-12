import React, { useState } from 'react';
import { useGame } from './GameContext';

export default function WordInput() {
    const { gameState, myPlayerId, submitWords, startRound } = useGame();
    const n = gameState?.config?.words_per_player ?? 3;
    const [words, setWords] = useState(() => Array(n).fill(''));

    if (!gameState) return null;
    const me = (gameState.players || []).find(p => p.id === myPlayerId);
    const isAdmin = gameState.host_id === myPlayerId;
    const allSubmitted = (gameState.players || []).every(p => p.has_submitted);

    const handleSubmit = (e) => {
        e.preventDefault();
        const cleaned = words.map(w => w.trim()).filter(Boolean);
        if (cleaned.length === 0) return;
        submitWords(cleaned);
    };

    return (
        <div className="card shadow-sm">
            <div className="card-body">
                <h3 className="text-center mb-3">Write Words</h3>
                <p className="text-muted text-center">
                    Submit {n} words to the shared pool. Each round we'll pick one and one of you will be the <strong>Fake Artist</strong>.
                </p>

                {me?.has_submitted ? (
                    <div className="alert alert-success text-center">
                        ✅ You're in. Pool size: <strong>{gameState.pool_size ?? 0}</strong>
                    </div>
                ) : (
                    <form onSubmit={handleSubmit}>
                        {words.map((w, i) => (
                            <div key={i} className="mb-2">
                                <input
                                    className="form-control"
                                    placeholder={`Word ${i + 1}`}
                                    value={w}
                                    onChange={e => {
                                        const next = [...words];
                                        next[i] = e.target.value;
                                        setWords(next);
                                    }}
                                />
                            </div>
                        ))}
                        <button className="btn btn-primary w-100 mt-2" type="submit">Submit</button>
                    </form>
                )}

                <h5 className="mt-4">Players</h5>
                <ul className="list-group">
                    {(gameState.players || []).map(p => (
                        <li key={p.id} className="list-group-item d-flex align-items-center">
                            <span className="me-2 d-inline-block rounded-circle border" style={{width:18, height:18, background:p.color}}></span>
                            <span className="flex-grow-1">{p.name}</span>
                            <span className={`badge ${p.has_submitted ? 'bg-success' : 'bg-secondary'}`}>
                                {p.has_submitted ? 'submitted' : 'writing…'}
                            </span>
                        </li>
                    ))}
                </ul>

                {isAdmin && (
                    <div className="d-grid mt-3">
                        <button className="btn btn-warning btn-lg" disabled={!allSubmitted} onClick={startRound}>
                            {allSubmitted ? 'Start Round 1' : 'Waiting for all players…'}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
