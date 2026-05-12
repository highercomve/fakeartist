import React from 'react';
import { useGame } from './GameContext';

export default function GameOver() {
    const { gameState, endGame, myPlayerId } = useGame();
    const players = gameState?.players || [];
    const isAdmin = gameState?.host_id === myPlayerId;
    const sorted = [...players].sort((a,b)=>b.score-a.score);
    const winner = gameState?.winner || sorted[0];

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

                {isAdmin && (
                    <button className="btn btn-danger" onClick={endGame}>Close Room</button>
                )}
            </div>
        </div>
    );
}
