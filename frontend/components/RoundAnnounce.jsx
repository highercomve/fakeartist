import React from 'react';
import { useGame } from './GameContext';

export default function RoundAnnounce() {
    const { gameState, myRole, startRound, myPlayerId } = useGame();
    const r = gameState?.current_round;
    const isAdmin = gameState?.host_id === myPlayerId;

    return (
        <div className="card shadow-sm">
            <div className="card-body text-center">
                <h2 className="mb-3">Round {(r?.index ?? 0) + 1}</h2>

                {myRole ? (
                    myRole.is_fake ? (
                        <div className="p-5 bg-dark text-white rounded">
                            <div style={{fontSize:'4rem', fontWeight:'bold'}}>X</div>
                            <div className="mt-2">You are the <strong>FAKE ARTIST</strong>.</div>
                            <div className="text-muted small mt-2">Pretend you know the word. Don't get caught.</div>
                        </div>
                    ) : (
                        <div className="p-5 bg-success text-white rounded">
                            <div className="text-uppercase small">Your word</div>
                            <div style={{fontSize:'2.4rem', fontWeight:'bold'}}>{myRole.word}</div>
                            <div className="text-light small mt-2">Hint at it. Don't make it too easy for the fake.</div>
                        </div>
                    )
                ) : (
                    <div className="alert alert-warning">Waiting for role…</div>
                )}

                <div className="mt-4">
                    <h6>Turn Order</h6>
                    <div className="d-flex justify-content-center flex-wrap gap-2">
                        {(r?.turn_order || []).map((pid, i) => {
                            const p = (gameState.players || []).find(x => x.id === pid);
                            if (!p) return null;
                            return (
                                <span key={pid} className="badge" style={{background:p.color, fontSize:'0.9rem'}}>
                                    {i+1}. {p.name}
                                </span>
                            );
                        })}
                    </div>
                </div>

                {isAdmin && (
                    <div className="d-grid mt-4">
                        <button className="btn btn-primary btn-lg" onClick={startRound}>Begin Drawing</button>
                    </div>
                )}
                {!isAdmin && <div className="text-muted small mt-3">Waiting for host…</div>}
            </div>
        </div>
    );
}
