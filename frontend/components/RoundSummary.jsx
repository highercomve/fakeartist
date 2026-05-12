import React from 'react';
import { useGame } from './GameContext';

export default function RoundSummary() {
    const { gameState, myPlayerId, nextRound } = useGame();
    const r = gameState?.current_round;
    const players = gameState?.players || [];
    const isAdmin = gameState?.host_id === myPlayerId;

    if (!r) return null;
    const fake = players.find(p => p.id === r.fake_id);
    const fakeWon = r.outcome === 'FAKE_WON';

    // tally votes for display
    const voteCounts = {};
    Object.values(r.votes || {}).forEach(s => { voteCounts[s] = (voteCounts[s] || 0) + 1; });

    return (
        <div className="card shadow-sm">
            <div className="card-body">
                <div className="text-center mb-3">
                    <h3>Round {r.index + 1} Summary</h3>
                    <div className={`alert ${fakeWon ? 'alert-dark' : 'alert-success'} my-3`}>
                        {fakeWon ? '🎭 Fake Artist wins this round!' : '🎨 Artists win this round!'}
                    </div>
                </div>

                <div className="row g-3 mb-3">
                    <div className="col-6 text-center">
                        <div className="text-muted small">The word was</div>
                        <div className="fs-4 fw-bold">{r.revealed_word}</div>
                    </div>
                    <div className="col-6 text-center">
                        <div className="text-muted small">The fake was</div>
                        <div className="fs-4 fw-bold">
                            {fake ? (
                                <span className="badge" style={{background:fake.color}}>{fake.name}</span>
                            ) : '—'}
                        </div>
                    </div>
                </div>

                {r.fake_guess && (
                    <div className="text-center mb-3">
                        <div className="text-muted small">Fake's guess</div>
                        <div className="fs-5">"{r.fake_guess}"</div>
                    </div>
                )}

                <h6>Votes</h6>
                <ul className="list-group mb-3">
                    {(r.turn_order || []).map(pid => {
                        const p = players.find(x => x.id === pid);
                        if (!p) return null;
                        const votedFor = r.votes?.[pid];
                        const target = players.find(x => x.id === votedFor);
                        return (
                            <li key={pid} className="list-group-item d-flex align-items-center">
                                <span className="me-2 d-inline-block rounded-circle border" style={{width:16, height:16, background:p.color}}></span>
                                <span className="flex-grow-1">{p.name}</span>
                                <span className="text-muted small me-2">→</span>
                                {target ? (
                                    <span className="badge" style={{background:target.color}}>{target.name}</span>
                                ) : <span className="text-muted small">no vote</span>}
                            </li>
                        );
                    })}
                </ul>

                <h6>Scoreboard</h6>
                <ul className="list-group mb-3">
                    {[...players].sort((a,b)=>b.score-a.score).map(p => (
                        <li key={p.id} className="list-group-item d-flex align-items-center">
                            <span className="me-2 d-inline-block rounded-circle border" style={{width:16, height:16, background:p.color}}></span>
                            <span className="flex-grow-1">{p.name}</span>
                            <span className="badge bg-primary">{p.score}</span>
                        </li>
                    ))}
                </ul>

                {isAdmin && (
                    <div className="d-grid">
                        <button className="btn btn-primary btn-lg" onClick={nextRound}>Next Round</button>
                    </div>
                )}
                {!isAdmin && <div className="text-muted small text-center">Waiting for host…</div>}
            </div>
        </div>
    );
}
