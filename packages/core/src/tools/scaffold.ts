import fs from "node:fs";
import path from "node:path";

/**
 * Ensure the app/ scaffold exists. index.html and App.tsx are always overwritten.
 * Main.tsx and style.css are owned by the LLM — only created if missing.
 */
export function createScaffold(appDir: string): void {
  fs.mkdirSync(appDir, { recursive: true });

  // Managed by the tool — always overwrite
  fs.writeFileSync(path.join(appDir, "index.html"), INDEX_HTML, "utf-8");
  fs.writeFileSync(path.join(appDir, "App.tsx"), APP_TSX, "utf-8");

  // Owned by the LLM — only create if missing
  const mainTsx = path.join(appDir, "Main.tsx");
  const styleCss = path.join(appDir, "style.css");
  if (!fs.existsSync(mainTsx)) fs.writeFileSync(mainTsx, MAIN_TSX, "utf-8");
  if (!fs.existsSync(styleCss)) fs.writeFileSync(styleCss, STYLE_CSS, "utf-8");
}

// ---------------------------------------------------------------------------
// index.html — Babel Standalone loader + esm.sh bare import rewriting
// ---------------------------------------------------------------------------

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>App</title>
  <link rel="stylesheet" href="./style.css">
</head>
<body>
  <div id="root"></div>
  <script type="module">
    const { transform } = await import('https://esm.sh/@babel/standalone@7');

    const BARE_IMPORTS = {
      'react': 'https://esm.sh/react@18',
      'react/jsx-runtime': 'https://esm.sh/react@18/jsx-runtime',
      'react-dom/client': 'https://esm.sh/react-dom@18/client',
    };

    const cache = new Map();

    async function loadModule(url) {
      if (cache.has(url)) return cache.get(url);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('Failed to fetch ' + url + ': ' + resp.status);
      const src = await resp.text();
      const compiled = transform(src, {
        presets: [
          ['react', { runtime: 'automatic' }],
          ['typescript', { allExtensions: true, isTSX: true }],
        ],
        filename: url,
      }).code;
      const rewritten = await rewriteImports(compiled, url);
      const blob = new Blob([rewritten], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      cache.set(url, blobUrl);
      return blobUrl;
    }

    async function rewriteImports(code, baseUrl) {
      // Strip CSS imports — stylesheets are loaded via <link> in HTML
      code = code.replace(/import\\s+['"][^'"]+\\.css['"]\\s*;?/g, '');

      // Collect all from '...' imports
      const regex = /(from\\s+['"])([^'"]+)(['"])/g;
      const tasks = [];
      let match;
      while ((match = regex.exec(code)) !== null) {
        const specifier = match[2];
        if (specifier.startsWith('.') && /\\.tsx?$/.test(specifier)) {
          tasks.push({
            idx: match.index,
            len: match[0].length,
            pre: match[1],
            suf: match[3],
            url: new URL(specifier, baseUrl).href,
            resolved: null,
          });
        } else if (BARE_IMPORTS[specifier]) {
          tasks.push({
            idx: match.index,
            len: match[0].length,
            pre: match[1],
            suf: match[3],
            resolved: BARE_IMPORTS[specifier],
          });
        }
      }

      // Resolve relative .tsx/.ts imports recursively
      for (const t of tasks) {
        if (!t.resolved) t.resolved = await loadModule(t.url);
      }

      // Replace in reverse to preserve indices
      for (let i = tasks.length - 1; i >= 0; i--) {
        const t = tasks[i];
        code = code.slice(0, t.idx) + t.pre + t.resolved + t.suf + code.slice(t.idx + t.len);
      }

      return code;
    }

    try {
      await import(await loadModule(new URL('./App.tsx', location.href).href));
    } catch (err) {
      document.getElementById('root').innerHTML =
        '<pre style="color:red;padding:1rem">' + err.message + '\\n\\n' + (err.stack || '') + '</pre>';
      console.error(err);
    }
  </script>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// App.tsx — Fixed entry: imports Main component and mounts it to DOM
// ---------------------------------------------------------------------------

const APP_TSX = `import { createRoot } from 'react-dom/client';
import Main from './Main.tsx';

createRoot(document.getElementById('root')!).render(<Main />);
`;

// ---------------------------------------------------------------------------
// Main.tsx — Placeholder; the LLM replaces this with the actual component
// ---------------------------------------------------------------------------

const MAIN_TSX = `export default function Main() {
  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Hello, World!</h1>
      <p>Edit Main.tsx to build your app.</p>
    </div>
  );
}
`;

// ---------------------------------------------------------------------------
// style.css — Minimal reset
// ---------------------------------------------------------------------------

const STYLE_CSS = `* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: system-ui, -apple-system, sans-serif; }
.app { padding: 2rem; }
`;
