import React from 'react';
import { GameProvider, useGame } from './GameContext';
import Home from './Home';
import Lobby from './Lobby';
import WordInput from './WordInput';
import RoundAnnounce from './RoundAnnounce';
import DrawCanvas from './DrawCanvas';
import Voting from './Voting';
import FakeGuess from './FakeGuess';
import RoundSummary from './RoundSummary';
import GameOver from './GameOver';

const GameRouter = () => {
    const { gameState, isConnected, joinGame, errorMsg } = useGame();

    if (!gameState) {
        return (
            <>
                {errorMsg && <div className="alert alert-danger">{errorMsg}</div>}
                <Home onJoin={(name, room) => joinGame(name, room)} isConnected={isConnected} />
            </>
        );
    }

    let view;
    switch (gameState.status) {
        case 'LOBBY': view = <Lobby />; break;
        case 'WRITING': view = <WordInput />; break;
        case 'ROUND_ANNOUNCE': view = <RoundAnnounce />; break;
        case 'DRAWING': view = <DrawCanvas />; break;
        case 'VOTING': view = <Voting />; break;
        case 'FAKE_GUESS': view = <FakeGuess />; break;
        case 'ROUND_SUMMARY': view = <RoundSummary />; break;
        case 'GAME_OVER': view = <GameOver />; break;
        default: view = <div className="alert alert-warning">Unknown: {gameState.status}</div>;
    }
    return (
        <>
            {errorMsg && <div className="alert alert-danger position-fixed top-0 start-50 translate-middle-x mt-2" style={{zIndex:1000}}>{errorMsg}</div>}
            {view}
        </>
    );
};

const Header = () => {
    const { gameState } = useGame();
    return (
        <div className="d-flex justify-content-between align-items-center mb-3">
            <div className="d-flex align-items-center">
                <span className="badge bg-dark me-2">Fake Artist</span>
                <span className="text-muted small">NYC Edition</span>
            </div>
            {gameState && gameState.id && (
                <div className="bg-light px-3 py-1 rounded border">
                    <span className="text-muted small me-2">Room:</span>
                    <span className="fw-bold text-primary font-monospace">{gameState.id}</span>
                </div>
            )}
        </div>
    );
};

export default function App({ initialData }) {
    return (
        <GameProvider initialData={initialData}>
            <div className="container py-3" style={{ maxWidth: '720px' }}>
                <Header />
                <GameRouter />
            </div>
        </GameProvider>
    );
}
