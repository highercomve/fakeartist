// Renders a finalized round as an Instagram-friendly PNG: app brand on
// top, the drawing in the middle, the word below, and a "play at <host>"
// footer. Triggers a download via a temporary <a>.

import type { Round } from "./models";

const W = 1080;
const H = 1350;        // portrait (4:5 ish — good for IG feed + stories)
const DRAW_PAD = 64;
const DRAW_TOP = 320;
const DRAW_H = 720;
const DRAW_ASPECT = 4 / 3;

export interface ExportOpts {
  round: Round;
  appName?: string;
  appUrl?: string;
  filename?: string;
}

export function exportRoundPng(opts: ExportOpts): void {
  const round = opts.round;
  const appName = opts.appName ?? "Fake Artist";
  const appUrl = opts.appUrl ?? (typeof window !== "undefined" ? window.location.host : "");
  const word = round.revealed_word || "";

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  // Background
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "#fef9f3");
  grad.addColorStop(1, "#f3eee6");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Header — app name
  ctx.fillStyle = "#1f2937";
  ctx.textAlign = "center";
  ctx.font = "700 96px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  ctx.fillText(appName, W / 2, 150);

  // Sub-header — tagline
  ctx.fillStyle = "#6b7280";
  ctx.font = "400 32px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  ctx.fillText("A Fake Artist Goes to New York — Web Edition", W / 2, 200);

  // Drawing frame
  const drawW = W - DRAW_PAD * 2;
  const drawH = drawW / DRAW_ASPECT;
  const drawX = DRAW_PAD;
  const drawY = DRAW_TOP;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(drawX, drawY, drawW, drawH);
  ctx.strokeStyle = "#d1d5db";
  ctx.lineWidth = 2;
  ctx.strokeRect(drawX, drawY, drawW, drawH);

  // Strokes — world coords are normalized [0,1] so just multiply by frame.
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 8;
  for (const s of round.strokes || []) {
    if (!s?.points || s.points.length < 2) continue;
    ctx.strokeStyle = s.color || "#000";
    ctx.beginPath();
    s.points.forEach((p, i) => {
      const x = drawX + p.x * drawW;
      const y = drawY + p.y * drawH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // Word caption
  ctx.fillStyle = "#9ca3af";
  ctx.textAlign = "center";
  ctx.font = "500 36px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  ctx.fillText("The word was", W / 2, DRAW_TOP + drawH + 80);

  ctx.fillStyle = "#111827";
  ctx.font = "800 100px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  ctx.fillText(word || "—", W / 2, DRAW_TOP + drawH + 180);

  // Footer — invite
  ctx.fillStyle = "#374151";
  ctx.font = "600 36px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  ctx.fillText(`Play at ${appUrl}`, W / 2, H - 60);

  // Trigger download
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safeWord = (word || "round").replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
    a.download = opts.filename ?? `fake-artist-${safeWord}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, "image/png");
}
