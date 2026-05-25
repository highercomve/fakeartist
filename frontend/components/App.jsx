import React from 'react';
import P2pDebug from './P2pDebug';
import P2pSolo from './P2pSolo';
import P2pGameProvider from './P2pGameProvider';

// PR 10 flips the default `/` route to the P2P provider. The legacy
// WebSocket GameProvider was removed alongside internal/game. Debug
// and solo routes remain available unchanged.
export default function App({ initialData: _initialData, path }) {
    if (path === '/p2p-debug') {
        return <P2pDebug />;
    }
    if (path === '/p2p-solo') {
        return <P2pSolo />;
    }
    // All other paths (including legacy `/` and `/p2p`) hit the P2P
    // provider. Per-route view selection is handled inside the provider.
    return <P2pGameProvider />;
}
