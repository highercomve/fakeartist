import React from 'react';
import { useGame } from './GameContext';
import StrokeViewer from './StrokeViewer';
import { exportRoundPng } from '../p2p/exportPng';

export default function GameOver() {
    const { gameState, endGame, myPlayerId } = useGame();
    const players = gameState?.players || [];
    const isAdmin = gameState?.host_id === myPlayerId;
    const sorted = [...players].sort((a,b)=>b.score-a.score);
    const winner = gameState?.winner || sorted[0];
    const playerById = (id) => players.find(p => p.id === id);
    const archive = gameState?.past_rounds || [];

    return (
        <div className="card shadow-sm">
            <div className="card-body text-center">
                <h2 className="mb-3">Game Over</h2>
                {winner && (
                    <div className="alert alert-success">
                        🏆 <strong>{winner.name}</strong> wins with {winner.score} points!
                    </div>
                )}

                <h5>Final Scores</h5>
                <ul className="list-group mb-4">
                    {sorted.map((p, i) => (
                        <li key={p.id} className="list-group-item d-flex align-items-center">
                            <span className="me-2 fw-bold">{i+1}.</span>
                            <span className="me-2 d-inline-block rounded-circle border" style={{width:18, height:18, background:p.color}}></span>
                            <span className="flex-grow-1 text-start">{p.name}</span>
                            <span className="badge bg-primary">{p.score}</span>
                        </li>
                    ))}
                </ul>

                {archive.length > 0 && (
                    <>
                        <h5 className="text-start">Round Drawings</h5>
                        {archive.map(r => {
                            const fake = playerById(r.fake_id);
                            return (
                                <div key={r.index} className="mb-3 text-start">
                                    <div className="small text-muted d-flex justify-content-between mb-1">
                                        <span>Round {r.index + 1} — <strong>{r.revealed_word}</strong></span>
                                        <span>
                                            {fake && <>Fake: <span className="badge" style={{background: fake.color}}>{fake.name}</span></>}
                                        </span>
                                    </div>
                                    <StrokeViewer strokes={r.strokes} />
                                    <div className="d-grid mt-2">
                                        <button
                                            className="btn btn-sm btn-outline-primary"
                                            onClick={() => exportRoundPng({ round: r })}
                                        >
                                            📷 Save image to share
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </>
                )}

                {isAdmin && (
                    <button className="btn btn-danger" onClick={endGame}>Close Room</button>
                )}
            </div>
        </div>
    );
}
