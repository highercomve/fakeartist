import React, { useState } from 'react';
import { useGame } from './GameContext';

export default function Voting() {
    const { gameState, myPlayerId, castVote } = useGame();
    const r = gameState?.current_round;
    const players = gameState?.players || [];
    const [picked, setPicked] = useState(null);

    if (!r) return null;
    const total = r.turn_order?.length || 0;
    const cast = r.votes_cast ?? 0;
    const submit = () => {
        if (!picked) return;
        castVote(picked);
    };

    return (
        <div className="card shadow-sm">
            <div className="card-body">
                <h3 className="text-center mb-3">Who is the Fake?</h3>
                <div className="text-center mb-3">
                    <span className="badge bg-secondary">Votes cast: {cast} / {total}</span>
                </div>

                <div className="d-grid gap-2">
                    {(r.turn_order || []).map(pid => {
                        if (pid === myPlayerId) return null; // can't vote yourself
                        const p = players.find(x => x.id === pid);
                        if (!p) return null;
                        const isPicked = picked === pid;
                        return (
                            <button
                                key={pid}
                                className={`btn ${isPicked ? 'btn-primary' : 'btn-outline-secondary'} text-start d-flex align-items-center`}
                                onClick={() => setPicked(pid)}
                            >
                                <span className="me-2 d-inline-block rounded-circle border" style={{width:20, height:20, background:p.color}}></span>
                                {p.name}
                            </button>
                        );
                    })}
                </div>

                <div className="d-grid mt-3">
                    <button className="btn btn-warning btn-lg" disabled={!picked} onClick={submit}>
                        Cast Vote
                    </button>
                </div>

                <div className="text-muted small text-center mt-3">
                    Votes stay private until everyone has voted.
                </div>
            </div>
        </div>
    );
}
