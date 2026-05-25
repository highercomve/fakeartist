import { createContext, useContext } from 'react';

// GameContext: shared value shape consumed by every screen component
// (Lobby, WordInput, DrawCanvas, etc.). The legacy WebSocket-backed
// GameProvider was deleted in PR 10; P2pGameProvider (frontend/components/
// P2pGameProvider.jsx) is the only provider that fills this context now.
export const GameContext = createContext(null);
export const useGame = () => useContext(GameContext);
