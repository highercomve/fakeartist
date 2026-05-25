import React, { useEffect, useRef } from 'react';
import { useGame } from './GameContext';

const ASPECT = 4 / 3;

// Read-only canvas that renders the current round's strokes. Used during
// VOTING / FAKE_GUESS / ROUND_SUMMARY so players can see what was drawn.
export default function StrokeViewer({ strokes: strokesProp }) {
    const { gameState } = useGame();
    const wrapRef = useRef(null);
    const canvasRef = useRef(null);

    const strokes = strokesProp ?? gameState?.current_round?.strokes ?? [];

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
            const ctx = canvas.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, cssW, cssH);
            ctx.strokeStyle = '#dee2e6';
            ctx.lineWidth = 1;
            ctx.strokeRect(0, 0, cssW, cssH);
            for (const s of strokes) {
                if (!s?.points || s.points.length < 2) continue;
                ctx.strokeStyle = s.color || '#000';
                ctx.lineWidth = 3;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.beginPath();
                s.points.forEach((p, i) => {
                    const x = p.x * cssW;
                    const y = p.y * cssH;
                    if (i === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                });
                ctx.stroke();
            }
        };
        fit();
        window.addEventListener('resize', fit);
        return () => window.removeEventListener('resize', fit);
    }, [strokes]);

    return (
        <div
            ref={wrapRef}
            style={{
                background: '#fff',
                borderRadius: 8,
                overflow: 'hidden',
                border: '1px solid #dee2e6',
            }}
        >
            <canvas ref={canvasRef} style={{display: 'block'}} />
        </div>
    );
}
