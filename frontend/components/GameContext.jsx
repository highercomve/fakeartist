import React, { createContext, useContext, useState, useEffect, useRef } from 'react';

const WS_MSG_STATE_UPDATE = 'STATE_UPDATE';
const WS_MSG_PLAYER_WELCOME = 'PLAYER_WELCOME';
const WS_MSG_YOUR_ROLE = 'YOUR_ROLE';
const WS_MSG_STROKE_ADDED = 'STROKE_ADDED';
const WS_MSG_ERROR = 'ERROR';

const CMD_JOIN_GAME = 'JOIN_GAME';
const CMD_CONFIGURE_GAME = 'CONFIGURE_GAME';
const CMD_SUBMIT_WORDS = 'SUBMIT_WORDS';
const CMD_START_GAME = 'START_GAME';
const CMD_START_ROUND = 'START_ROUND';
const CMD_SUBMIT_STROKE = 'SUBMIT_STROKE';
const CMD_CAST_VOTE = 'CAST_VOTE';
const CMD_SUBMIT_FAKE_GUESS = 'SUBMIT_FAKE_GUESS';
const CMD_NEXT_ROUND = 'NEXT_ROUND';
const CMD_END_GAME = 'END_GAME';

const GameContext = createContext(null);
export const useGame = () => useContext(GameContext);

export const GameProvider = ({ children, initialData }) => {
    const [gameState, setGameState] = useState(null);
    const [isConnected, setIsConnected] = useState(false);
    const [myPlayerId, setMyPlayerId] = useState(null);
    const [myRole, setMyRole] = useState(null); // {is_fake, word?}
    const [errorMsg, setErrorMsg] = useState(null);
    const wsRef = useRef(null);
    const strokeListenersRef = useRef([]);

    useEffect(() => {
        if (typeof window !== 'undefined') {
            const savedId = localStorage.getItem('fakeartist_playerId');
            if (savedId) setMyPlayerId(savedId);
        }
    }, []);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/api/ws`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => setIsConnected(true);
        ws.onclose = () => setIsConnected(false);
        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === WS_MSG_STATE_UPDATE) {
                    setGameState(msg.payload);
                    const status = msg.payload?.status;
                    if (status === 'WRITING' || status === 'LOBBY') {
                        setMyRole(null);
                    }
                } else if (msg.type === WS_MSG_PLAYER_WELCOME) {
                    setMyPlayerId(msg.payload.id);
                    localStorage.setItem('fakeartist_playerId', msg.payload.id);
                } else if (msg.type === WS_MSG_YOUR_ROLE) {
                    setMyRole(msg.payload);
                } else if (msg.type === WS_MSG_STROKE_ADDED) {
                    strokeListenersRef.current.forEach(fn => fn(msg.payload));
                } else if (msg.type === WS_MSG_ERROR) {
                    setErrorMsg(msg.payload.message);
                    setTimeout(() => setErrorMsg(null), 4000);
                }
            } catch (e) {
                console.error('WS parse failed', e);
            }
        };
        return () => ws.close();
    }, []);

    const sendCommand = (type, payload = {}) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type, payload }));
        }
    };

    const onStroke = (fn) => {
        strokeListenersRef.current.push(fn);
        return () => {
            strokeListenersRef.current = strokeListenersRef.current.filter(f => f !== fn);
        };
    };

    const joinGame = (playerName, roomCode) => {
        const payload = { player_name: playerName, room_code: roomCode };
        if (myPlayerId) payload.id = myPlayerId;
        sendCommand(CMD_JOIN_GAME, payload);
    };

    return (
        <GameContext.Provider value={{
            gameState, isConnected, myPlayerId, myRole, errorMsg,
            joinGame,
            configureGame: (c) => sendCommand(CMD_CONFIGURE_GAME, c),
            submitWords: (words) => sendCommand(CMD_SUBMIT_WORDS, { words }),
            startGame: () => sendCommand(CMD_START_GAME),
            startRound: () => sendCommand(CMD_START_ROUND),
            submitStroke: (points) => sendCommand(CMD_SUBMIT_STROKE, { points }),
            castVote: (suspectId) => sendCommand(CMD_CAST_VOTE, { suspect_id: suspectId }),
            submitFakeGuess: (guess) => sendCommand(CMD_SUBMIT_FAKE_GUESS, { guess }),
            nextRound: () => sendCommand(CMD_NEXT_ROUND),
            endGame: () => sendCommand(CMD_END_GAME),
            onStroke,
        }}>
            {children}
        </GameContext.Provider>
    );
};
