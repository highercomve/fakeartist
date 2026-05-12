import React, { useState } from 'react';
import { useGame } from './GameContext';

export default function FakeGuess() {
    const { gameState, myPlayerId, myRole, submitFakeGuess } = useGame();
    const [guess, setGuess] = useState('');

    const r = gameState?.current_round;
    const isFake = myRole?.is_fake === true;

    if (!r) return null;

    if (isFake) {
        return (
            <div className="card shadow-sm">
                <div className="card-body text-center">
                    <h3>You were caught!</h3>
                    <p className="text-muted">Last chance — guess the word the artists were drawing.</p>
                    <form onSubmit={(e) => { e.preventDefault(); if (guess.trim()) submitFakeGuess(guess.trim()); }}>
                        <input
                            className="form-control form-control-lg text-center"
                            placeholder="Type the word…"
                            value={guess}
                            onChange={e => setGuess(e.target.value)}
                            autoFocus
                        />
                        <button className="btn btn-primary btn-lg w-100 mt-3" type="submit" disabled={!guess.trim()}>
                            Submit Guess
                        </button>
                    </form>
                </div>
            </div>
        );
    }

    return (
        <div className="card shadow-sm">
            <div className="card-body text-center">
                <h3>The Fake was caught!</h3>
                <p className="text-muted">Waiting for them to guess the word…</p>
                <div className="spinner-border text-warning" role="status"></div>
            </div>
        </div>
    );
}
