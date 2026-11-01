// Build a single self-contained HTML file: node build.js  -> RawEditor.html
const fs = require('fs'), path = require('path');
const src = p => fs.readFileSync(path.join(__dirname, 'src', p), 'utf8');
const strip = s => s.replace(/^export\s*\{[^}]*\};?\s*$/mg, '').replace(/^import\s.*$/mg, '');
const glue = src('vendor/libraw.mjs').replace(/export default Module;?\s*$/, '').replace(/import\.meta\.url/g, 'self.location.href');
const worker = glue + '\n' + src('lensmeta.js') + '\n' + src('nikonfast.js') + '\n' + src('worker.js');
const wasm = fs.readFileSync(path.join(__dirname, 'src/vendor/libraw.wasm')).toString('base64');
const main = ['shaders.js', 'presets.js', 'curve.js', 'jpeg.js', 'tiff.js', 'gl.js', 'imgdecode.js', 'filmluts.js', 'app.js'].map(f => `// ===== ${f} =====\n` + strip(src(f))).join('\n');
// guard against accidental </script> sequences inside inlined code
const safe = s => s.replace(/<\/script/gi, '<\\/script');
let html = src('index.html');
html = html.replace('__CSS__', () => src('style.css')).replace('__WORKER__', () => safe(worker)).replace('"__WASM__"', () => '"' + wasm + '"').replace('__MAIN__', () => safe(main));
const out = path.join(__dirname, 'RawEditor.html');
fs.writeFileSync(out, html);
console.log('wrote', out, (fs.statSync(out).size / 1048576).toFixed(2), 'MB');
// syntax check the pieces
try { new Function(worker); console.log('worker: syntax ok'); } catch (e) { console.error('worker syntax error:', e.message); process.exitCode = 1; }
try { new Function('"use strict"; const WASM_B64=""; return (async()=>{' + main + '})'); console.log('main: syntax ok'); } catch (e) { console.error('main syntax error:', e.message); process.exitCode = 1; }
