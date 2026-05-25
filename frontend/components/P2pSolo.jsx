import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GameContext } from './GameContext';
import { Engine } from '../p2p/engine';
import { LoopbackTransport } from '../p2p/transport';
import { Replica } from '../p2p/replica';
import Lobby from './Lobby';
import WordInput from './WordInput';
import RoundAnnounce from './RoundAnnounce';
import DrawCanvas from './DrawCanvas';
import Voting from './Voting';
import FakeGuess from './FakeGuess';
import RoundSummary from './RoundSummary';
import GameOver from './GameOver';

// Solo mode: a single-tab playground that exercises the host-side
// engine via LoopbackTransport. Sets min_players=1 so the entire game
// is playable by one user. No WS, no signaling, no peers.
//
// This is the user-visible verification for T4.8: walk through
// Lobby -> WordInput -> RoundAnnounce -> DrawCanvas -> Voting -> Summary.

const SELF_ID = 'solo-player';

export default function P2pSolo() {
    // Build engine + transport + replica once. Putting them in a ref
    // keeps them stable across renders without burning a useEffect.
    const refs = useRef(null);
    if (!refs.current) {
        const engine = new Engine('solo-room', { config: { min_players: 1, target_score: 3, strokes_per_artist: 2 } });
        const transport = new LoopbackTransport({ engine, selfPlayerId: SELF_ID });
        const replica = new Replica();
        refs.current = { engine, transport, replica };
    }
    const { transport, replica } = refs.current;

    const [snapshot, setSnapshot] = useState(replica.snapshot);
    const [errorMsg, setErrorMsg] = useState(null);
    const strokeListenersRef = useRef([]);

    useEffect(() => {
        const offEvt = transport.onEvent((evt) => replica.apply(evt));
        const offChange = replica.onChange((s) => setSnapshot({ ...s }));
        const offStroke = replica.onStroke((p) => {
            strokeListenersRef.current.forEach((fn) => fn(p));
        });
        const offError = replica.onError((msg) => {
            setErrorMsg(msg);
            setTimeout(() => setErrorMsg(null), 4000);
        });
        return () => {
            offEvt();
            offChange();
            offStroke();
            offError();
            transport.close();
        };
    }, [transport, replica]);

    const sendCmd = (type, payload = {}) => transport.send({ type, payload });

    const value = useMemo(() => ({
        gameState: snapshot.state,
        isConnected: true,
        myPlayerId: snapshot.myId,
        myRole: snapshot.myRole,
        errorMsg,
        joinGame: (playerName) => sendCmd('JOIN_GAME', { id: SELF_ID, player_name: playerName }),
        configureGame: (c) => sendCmd('CONFIGURE_GAME', c),
        submitWords: (words) => sendCmd('SUBMIT_WORDS', { words }),
        startGame: () => sendCmd('START_GAME'),
        startRound: () => sendCmd('START_ROUND'),
        submitStroke: (points) => sendCmd('SUBMIT_STROKE', { points }),
        castVote: (suspectId) => sendCmd('CAST_VOTE', { suspect_id: suspectId }),
        submitFakeGuess: (guess) => sendCmd('SUBMIT_FAKE_GUESS', { guess }),
        nextRound: () => sendCmd('NEXT_ROUND'),
        endGame: () => sendCmd('END_GAME'),
        onStroke: (fn) => {
            strokeListenersRef.current.push(fn);
            return () => { strokeListenersRef.current = strokeListenersRef.current.filter((f) => f !== fn); };
        },
    }), [snapshot, errorMsg, transport]);

    const gs = snapshot.state;
    let view;
    if (!gs) {
        view = (
            <div className="card p-4 text-center">
                <h3>P2P Solo (local)</h3>
                <p className="text-muted">Loopback engine. Click below to start.</p>
                <button className="btn btn-primary" onClick={() => value.joinGame('You')}>Join as You</button>
            </div>
        );
    } else {
        switch (gs.status) {
            case 'LOBBY': view = <Lobby />; break;
            case 'WRITING': view = <WordInput />; break;
            case 'ROUND_ANNOUNCE': view = <RoundAnnounce />; break;
            case 'DRAWING': view = <DrawCanvas />; break;
            case 'VOTING': view = <Voting />; break;
            case 'FAKE_GUESS': view = <FakeGuess />; break;
            case 'ROUND_SUMMARY': view = <RoundSummary />; break;
            case 'GAME_OVER': view = <GameOver />; break;
            default: view = <div>Unknown status: {gs.status}</div>;
        }
    }

    return (
        <GameContext.Provider value={value}>
            <div className="container py-3" style={{ maxWidth: 720 }}>
                <div className="d-flex justify-content-between align-items-center mb-3">
                    <span className="badge bg-warning text-dark">P2P SOLO (local engine)</span>
                    {gs && gs.id && <span className="badge bg-secondary">Room: {gs.id}</span>}
                </div>
                {errorMsg && <div className="alert alert-danger">{errorMsg}</div>}
                {view}
            </div>
        </GameContext.Provider>
    );
}
