import React, { useEffect, useRef, useState } from 'react';
import { useGame } from './GameContext';

// World coordinates are normalized to [0,1]. The canvas view applies
// an affine transform (scale, translate) that is local to each client.

const MIN_SCALE = 0.5;
const MAX_SCALE = 8.0;
const ASPECT = 4 / 3;

export default function DrawCanvas() {
    const { gameState, myPlayerId, myRole, submitStroke, onStroke } = useGame();
    const canvasRef = useRef(null);
    const wrapRef = useRef(null);

    // Pointer tracking
    const pointersRef = useRef(new Map()); // id -> {clientX, clientY}
    const modeRef = useRef('idle'); // 'idle' | 'draw' | 'nav'
    const localStrokeRef = useRef([]); // world points of in-progress stroke
    const navStartRef = useRef(null);  // {dist, mid, transform}

    // View transform
    const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
    const viewRef = useRef(view);
    useEffect(() => { viewRef.current = view; }, [view]);

    // Confirmed strokes from server + live stroke deltas
    const [liveStrokes, setLiveStrokes] = useState([]);
    useEffect(() => {
        const unsub = onStroke(({ stroke }) => {
            setLiveStrokes(prev => [...prev, stroke]);
        });
        return unsub;
    }, [onStroke]);

    // Reset live strokes when the round resets via state update
    useEffect(() => {
        const s = gameState?.current_round?.strokes || [];
        setLiveStrokes(s);
    }, [gameState?.current_round?.index]);

    const r = gameState?.current_round;
    const players = gameState?.players || [];
    const playerById = (id) => players.find(p => p.id === id);
    const turnOrder = r?.turn_order || [];
    const totalNeeded = (gameState?.config?.strokes_per_artist ?? 2) * turnOrder.length;
    const strokeIdx = r?.stroke_index ?? 0;
    const currentTurnPlayerId = turnOrder.length ? turnOrder[strokeIdx % turnOrder.length] : null;
    const isMyTurn = currentTurnPlayerId === myPlayerId;

    // ----- Resize + DPR -----
    const sizeRef = useRef({ cssW: 0, cssH: 0, dpr: 1 });
    useEffect(() => {
        const fit = () => {
            const wrap = wrapRef.current;
            const canvas = canvasRef.current;
            if (!wrap || !canvas) return;
            const cssW = wrap.clientWidth;
            const cssH = cssW / ASPECT;
            const dpr = Math.min(window.devicePixelRatio || 1, 3);
            canvas.style.width = cssW + 'px';
            canvas.style.height = cssH + 'px';
            canvas.width = Math.floor(cssW * dpr);
            canvas.height = Math.floor(cssH * dpr);
            sizeRef.current = { cssW, cssH, dpr };
            redraw();
        };
        fit();
        window.addEventListener('resize', fit);
        return () => window.removeEventListener('resize', fit);
        // eslint-disable-next-line
    }, []);

    // ----- Rendering -----
    const redraw = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const { cssW, cssH, dpr } = sizeRef.current;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Apply view transform (in CSS px space scaled by dpr)
        const { scale, tx, ty } = viewRef.current;
        ctx.setTransform(scale * dpr, 0, 0, scale * dpr, tx * dpr, ty * dpr);

        // World fills [0,1]x[0,1] mapped to cssW x cssH (before view transform)
        // To draw, multiply world coords by (cssW, cssH).
        const drawStroke = (stroke) => {
            if (!stroke || !stroke.points || stroke.points.length < 2) return;
            ctx.strokeStyle = stroke.color || '#000';
            ctx.lineWidth = 3 / scale;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.beginPath();
            stroke.points.forEach((pt, i) => {
                const x = pt.x * cssW;
                const y = pt.y * cssH;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            });
            ctx.stroke();
        };

        // Border of world
        ctx.strokeStyle = '#dee2e6';
        ctx.lineWidth = 1 / scale;
        ctx.strokeRect(0, 0, cssW, cssH);

        liveStrokes.forEach(drawStroke);

        // Local in-progress
        const me = playerById(myPlayerId);
        if (modeRef.current === 'draw' && localStrokeRef.current.length >= 2 && me) {
            drawStroke({ color: me.color, points: localStrokeRef.current });
        }
    };

    useEffect(() => { redraw(); }, [liveStrokes, view]);

    // ----- Coord helpers -----
    const clientToWorld = (clientX, clientY) => {
        const canvas = canvasRef.current;
        const rect = canvas.getBoundingClientRect();
        const localX = clientX - rect.left;
        const localY = clientY - rect.top;
        const { scale, tx, ty } = viewRef.current;
        const cssX = (localX - tx) / scale;
        const cssY = (localY - ty) / scale;
        const { cssW, cssH } = sizeRef.current;
        return { x: cssX / cssW, y: cssY / cssH };
    };

    const clampScale = (s) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));

    // ----- Pointer events -----
    const handlePointerDown = (e) => {
        e.preventDefault();
        const canvas = canvasRef.current;
        canvas.setPointerCapture(e.pointerId);
        pointersRef.current.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });

        if (pointersRef.current.size === 1) {
            if (!isMyTurn) {
                modeRef.current = 'idle';
                return;
            }
            // start draw
            modeRef.current = 'draw';
            localStrokeRef.current = [];
            const w = clientToWorld(e.clientX, e.clientY);
            localStrokeRef.current.push(w);
            redraw();
        } else if (pointersRef.current.size === 2) {
            // cancel any draw and enter nav
            modeRef.current = 'nav';
            localStrokeRef.current = [];
            const pts = Array.from(pointersRef.current.values());
            navStartRef.current = {
                dist: dist(pts[0], pts[1]),
                mid:  mid(pts[0], pts[1]),
                transform: { ...viewRef.current },
            };
            redraw();
        }
    };

    const handlePointerMove = (e) => {
        if (!pointersRef.current.has(e.pointerId)) return;
        e.preventDefault();
        pointersRef.current.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });

        if (modeRef.current === 'draw' && pointersRef.current.size === 1) {
            const w = clientToWorld(e.clientX, e.clientY);
            // limit point density a bit
            const last = localStrokeRef.current[localStrokeRef.current.length - 1];
            if (!last || Math.hypot((last.x - w.x), (last.y - w.y)) > 0.002) {
                localStrokeRef.current.push(w);
                redraw();
            }
        } else if (modeRef.current === 'nav' && pointersRef.current.size >= 2) {
            const pts = Array.from(pointersRef.current.values()).slice(0, 2);
            const newDist = dist(pts[0], pts[1]);
            const newMid = mid(pts[0], pts[1]);
            const start = navStartRef.current;
            if (!start || start.dist === 0) return;

            // Scale
            const newScale = clampScale(start.transform.scale * (newDist / start.dist));
            // Translate so the start midpoint (in canvas-local) stays under new screen midpoint.
            // We anchor on the start midpoint in CSS coords.
            const rect = canvasRef.current.getBoundingClientRect();
            const startMidLocal = {
                x: start.mid.x - rect.left,
                y: start.mid.y - rect.top,
            };
            const newMidLocal = {
                x: newMid.x - rect.left,
                y: newMid.y - rect.top,
            };
            // The world point under the start midpoint (using start transform):
            //   worldCss = (startMidLocal - start.tx) / start.scale
            const worldX = (startMidLocal.x - start.transform.tx) / start.transform.scale;
            const worldY = (startMidLocal.y - start.transform.ty) / start.transform.scale;
            // We want: newMidLocal = worldCss * newScale + newTranslate
            const newTx = newMidLocal.x - worldX * newScale;
            const newTy = newMidLocal.y - worldY * newScale;

            setView({ scale: newScale, tx: newTx, ty: newTy });
        }
    };

    const finishPointer = (e) => {
        if (!pointersRef.current.has(e.pointerId)) return;
        try { canvasRef.current.releasePointerCapture(e.pointerId); } catch (_) {}
        pointersRef.current.delete(e.pointerId);

        if (modeRef.current === 'draw' && pointersRef.current.size === 0) {
            const pts = localStrokeRef.current;
            if (pts.length >= 2 && isMyTurn) {
                submitStroke(pts.map(p => ({ x: clamp01(p.x), y: clamp01(p.y) })));
            }
            localStrokeRef.current = [];
            modeRef.current = 'idle';
            redraw();
        } else if (modeRef.current === 'nav' && pointersRef.current.size < 2) {
            // exit nav; require fresh full lift to draw again
            modeRef.current = pointersRef.current.size === 0 ? 'idle' : 'nav';
            navStartRef.current = null;
        }
    };

    // React 17+ attaches onWheel as a passive listener, so e.preventDefault()
    // is silently ignored — Mac trackpads would scroll the page instead of
    // zooming the canvas. Bind natively with {passive: false}.
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const onWheel = (e) => {
            e.preventDefault();
            const factor = Math.exp(-e.deltaY * 0.001);
            const start = viewRef.current;
            const newScale = clampScale(start.scale * factor);
            const rect = canvas.getBoundingClientRect();
            const localX = e.clientX - rect.left;
            const localY = e.clientY - rect.top;
            const worldX = (localX - start.tx) / start.scale;
            const worldY = (localY - start.ty) / start.scale;
            const newTx = localX - worldX * newScale;
            const newTy = localY - worldY * newScale;
            setView({ scale: newScale, tx: newTx, ty: newTy });
        };
        canvas.addEventListener('wheel', onWheel, { passive: false });
        return () => canvas.removeEventListener('wheel', onWheel);
    }, []);

    const resetView = () => setView({ scale: 1, tx: 0, ty: 0 });

    // ----- UI -----
    const currentPlayer = playerById(currentTurnPlayerId);

    return (
        <div className="card shadow-sm">
            <div className="card-body p-2 p-md-3">
                <div className="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2">
                    <div>
                        <span className="text-muted small me-2">Turn {strokeIdx + 1}/{totalNeeded}</span>
                        {currentPlayer && (
                            <span className="badge" style={{background: currentPlayer.color}}>
                                {currentPlayer.name}{currentTurnPlayerId === myPlayerId ? ' (you)' : ''}
                            </span>
                        )}
                    </div>
                    <div className="d-flex gap-2 align-items-center">
                        <span className="text-muted small">{Math.round(view.scale * 100)}%</span>
                        {(view.scale !== 1 || view.tx !== 0 || view.ty !== 0) && (
                            <button className="btn btn-sm btn-outline-secondary" onClick={resetView}>Reset View</button>
                        )}
                    </div>
                </div>

                <div
                    ref={wrapRef}
                    className="canvas-wrap"
                    style={{
                        position: 'relative',
                        touchAction: 'none',
                        userSelect: 'none',
                        WebkitUserSelect: 'none',
                        background: '#fff',
                        borderRadius: 8,
                        overflow: 'hidden',
                        border: '1px solid #dee2e6',
                    }}
                >
                    <canvas
                        ref={canvasRef}
                        onPointerDown={handlePointerDown}
                        onPointerMove={handlePointerMove}
                        onPointerUp={finishPointer}
                        onPointerCancel={finishPointer}
                        onPointerLeave={finishPointer}
                        style={{display:'block', touchAction:'none', cursor: isMyTurn ? 'crosshair' : 'default'}}
                    />
                </div>

                <div className="mt-2 small text-muted text-center">
                    1 finger to draw — 2 fingers to zoom &amp; pan
                </div>

                {myRole && (
                    <div className="mt-2 text-center">
                        {myRole.is_fake ? (
                            <span className="badge bg-dark">Your role: X (Fake)</span>
                        ) : (
                            <span className="badge bg-success">Your word: {myRole.word}</span>
                        )}
                    </div>
                )}

                <div className="mt-3 d-flex flex-wrap gap-2 justify-content-center">
                    {turnOrder.map((pid, i) => {
                        const p = playerById(pid);
                        if (!p) return null;
                        const isCur = pid === currentTurnPlayerId;
                        return (
                            <span key={pid}
                                  className="px-2 py-1 rounded"
                                  style={{
                                      background: p.color,
                                      color: '#fff',
                                      opacity: isCur ? 1 : 0.5,
                                      fontWeight: isCur ? 700 : 400,
                                      border: isCur ? '2px solid #000' : '2px solid transparent',
                                  }}>
                                {i+1}. {p.name}
                            </span>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

function dist(a, b) {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}
function mid(a, b) {
    return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
