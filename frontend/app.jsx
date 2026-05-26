import React from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import App from './components/App';

if (typeof window !== 'undefined') {
    const root = document.getElementById('root');
    const data = window.__INITIAL_STATE__ || {};
    hydrateRoot(root, <App initialData={data} path={window.location.pathname} />);
}

if (typeof globalThis !== 'undefined') {
    globalThis.SSR_RENDER = (url, state) => {
        const appHtml = renderToString(<App initialData={state} path={url} />);
        return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>Fake Artist</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <style>
      html, body { overscroll-behavior: none; }
      .canvas-wrap { touch-action: none; }
      /* Suppress the gray tap-highlight rectangle on iOS Safari. */
      * { -webkit-tap-highlight-color: transparent; }
      /* iOS Safari sometimes auto-zooms when focusing an input whose
         computed font-size is < 16px; Bootstrap's defaults are >= 16px
         but inputs inside .input-group-sm drop to 14px. Pin them. */
      .form-control, .form-select { font-size: 16px; }
    </style>
</head>
<body class="bg-light">
    <div id="root">${appHtml}</div>
    <script>window.__INITIAL_STATE__ = ${JSON.stringify(state)}</script>
    <script src="/assets/app.js"></script>
</body>
</html>`;
    };
}
