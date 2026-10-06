const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
const source = readFileSync(`${__dirname}/Game.tsx`, 'utf8');
const ast = ts.createSourceFile('Game.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
const functions = new Map(), effects = [], bindings = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect') effects.push(node.arguments[0]);
  if (ts.isJsxAttribute(node) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
    const name = node.name.getText(ast), expression = node.initializer.expression.getText(ast);
    if ((name === 'onClick' || name === 'onExit') && ['handleExit', 'onExit'].includes(expression)) bindings.push({ name, expression });
  }
  ts.forEachChild(node, visit);
}
visit(ast);
const names = ['haltAmbient', 'haltGameAudio', 'handleExit', 'handlePause', 'tryStartAmbient', 'canPlayGameAmbient', 'planGameAudio'];
const declarations = names.map(name => { assert.ok(functions.has(name), name); return functions.get(name).getText(ast); }).join('\n');
const mount = effects.find(node => node.getText(ast).includes('setMuted(!_appState.soundEnabled)'));
const visibility = effects.find(node => node.getText(ast).includes("document.addEventListener('visibilitychange'"));
assert.ok(mount && visibility);
const start = source.indexOf("      const terminal = gs.victory ? 'victory'");
const end = source.indexOf('      drawRef.current();', start);
assert.ok(start > 0 && end > start);
function fixture() {
  const events = [], voices = new Set(), listeners = new Map();
  const audio = { ambient: true, muted: false, context: {} };
  const gsRef = { current: { paused: false, gameOver: false, victory: false, soundQueue: [] } };
  const ambientStartedRef = { current: true }, resultSoundSeenRef = { current: false }, lastTimeRef = { current: 99 };
  const document = { hidden: false, addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name, handler) { assert.equal(listeners.get(name), handler); listeners.delete(name); } };
  const stopAmbient = () => { events.push('ambient-stop'); audio.ambient = false; };
  const stopGameAudio = () => { events.push('game-stop'); audio.ambient = false; voices.clear(); };
  const playSfx = tag => { events.push(`play:${tag}`); voices.add(tag); };
  const app = { soundEnabled: true };
  const persistenceErrorRef = { current: false }, exitRequestedRef = { current: null };
  let hidden = false;
  const timing = { snapshot: () => ({ hidden }), command(input) {
    if (input.type === 'visibility') { hidden = input.hidden; if (hidden && !gsRef.current.victory && !gsRef.current.gameOver) gsRef.current.paused = true; }
    else gsRef.current.paused = input.type === 'pause';
  } };
  const api = new Function('exports', 'stopAmbient', 'stopGameAudio', 'ambientStartedRef', 'gsRef', 'lastTimeRef', 'document', '_appState',
    'isMuted', 'initAudio', 'startAmbient', 'setRenderTick', 'settleCurrentRun', 'onExit', 'setMuted',
    'timing', 'saveCheckpoint', 'persistenceErrorRef', 'suspended', 'persistenceBlocked', 'exitRequestedRef', 'window',
    compile(`${declarations};return { haltAmbient, haltGameAudio, handleExit, handlePause, planGameAudio,
      mount: ${mount.getText(ast)}, visibility: ${visibility.getText(ast)} };`))(
    {}, stopAmbient, stopGameAudio, ambientStartedRef, gsRef, lastTimeRef, document, app, () => audio.muted,
    () => events.push('init'), () => { events.push('ambient-start'); audio.ambient = true; },
    () => events.push('render'), () => { events.push('settle'); return true; }, () => events.push('exit'), value => { audio.muted = value; },
    timing, () => { events.push('save'); return true; }, persistenceErrorRef, false, false, exitRequestedRef, document);
  const frame = new Function('gs', 'document', 'ambientStartedRef', 'haltGameAudio', 'haltAmbient', 'planGameAudio',
    'resultSoundSeenRef', 'isMuted', 'playSfx', compile(source.slice(start, end)));
  return { api, audio, events, voices, listeners, document, gsRef, ambientStartedRef, lastTimeRef, resultSoundSeenRef,
    frame() { frame(gsRef.current, document, ambientStartedRef, api.haltGameAudio, api.haltAmbient, api.planGameAudio,
      resultSoundSeenRef, () => audio.muted, playSfx); } };
}
{
  const f = fixture(), context = f.audio.context; f.voices.add('scheduled-shot');
  f.api.handlePause(); assert.equal(f.gsRef.current.paused, true); assert.equal(f.voices.size, 0);
  assert.equal(f.audio.ambient, false); assert.equal(f.ambientStartedRef.current, false); assert.equal(f.lastTimeRef.current, null);
  assert.equal(f.audio.context, context); assert.equal(f.audio.muted, false);
  f.api.handlePause(); assert.equal(f.gsRef.current.paused, false); assert.equal(f.audio.ambient, true);
}
for (const terminal of [false, true]) {
  const f = fixture(); f.api.visibility(); f.gsRef.current.victory = terminal;
  f.voices.add('scheduled-shot'); f.ambientStartedRef.current = false;
  f.document.hidden = true; f.listeners.get('visibilitychange')();
  assert.equal(f.voices.size, 0, 'hidden stops voices even with no ambient or terminal already entered');
  assert.equal(f.gsRef.current.paused, !terminal); assert.equal(f.lastTimeRef.current, null);
  f.gsRef.current.soundQueue.push('build'); f.frame(); assert.equal(f.voices.size, 0);
}
for (const outcome of ['victory', 'gameOver']) {
  const f = fixture(); f.voices.add('existing-shot'); f.gsRef.current[outcome] = true;
  const context = f.audio.context; f.frame();
  const cue = outcome === 'victory' ? 'victory' : 'defeat';
  assert.ok(f.voices.has(cue)); assert.ok(f.voices.has('existing-shot'), 'terminal only halts ambient');
  for (let i = 0; i < 30; i++) f.frame();
  assert.ok(f.voices.has(cue), 'terminal cue not cut on later frames');
  assert.equal(f.events.filter(e => e === `play:${cue}`).length, 1);
  assert.equal(f.events.filter(e => e === 'ambient-stop').length, 1);
  assert.equal(f.events.filter(e => e === 'game-stop').length, 0);
  assert.equal(f.audio.context, context);
  f.api.visibility(); f.document.hidden = true; f.listeners.get('visibilitychange')();
  assert.equal(f.voices.size, 0, 'hidden transition clears terminal cue without another RAF');
}
{
  const f = fixture(); f.ambientStartedRef.current = false; f.gsRef.current.paused = true; f.voices.add('shot');
  f.api.haltGameAudio();
  const stops = f.events.filter(e => e === 'game-stop').length;
  for (let i = 0; i < 30; i++) f.frame();
  assert.equal(f.voices.size, 0);
  assert.equal(f.events.filter(e => e === 'game-stop').length, stops, 'idle frames never repeat audio teardown');
}
{
  const f = fixture(); f.voices.add('shot'); f.api.handleExit();
  assert.equal(f.gsRef.current.paused, true); assert.equal(f.voices.size, 0);
  assert.equal(f.events.filter(event => event === 'exit').length, 1, 'one external confirmation request, no nested dialog');
  assert.ok(f.events.includes('save')); assert.ok(!f.events.includes('settle'), 'live exit request saves without premature settlement');
  f.gsRef.current.gameOver = true; f.api.handleExit();
  assert.deepEqual(f.events.slice(-3), ['game-stop', 'settle', 'exit']);
  assert.equal(f.ambientStartedRef.current, false);
  assert.ok(bindings.some(b => b.name === 'onExit' && b.expression === 'handleExit'), 'HUD exit bound to tested handler');
  assert.ok(bindings.some(b => b.name === 'onClick' && b.expression === 'handleExit'), 'Home bound to tested handler');
  assert.equal(new Function('onExit', 'return onExit;')(f.api.handleExit), f.api.handleExit, 'HUD forwarding preserves handler');
}
{
  const f = fixture(); f.voices.add('old-shot'); const cleanup = f.api.mount();
  assert.equal(f.voices.size, 0, 'mount clears prior game voices'); f.voices.add('scheduled-shot');
  const context = f.audio.context; cleanup(); assert.equal(f.voices.size, 0); assert.equal(f.audio.ambient, false);
  assert.equal(f.audio.context, context); assert.equal(f.audio.muted, false); assert.equal(f.ambientStartedRef.current, false);
}
console.log('Game audio lifecycle PASS: executable pause/resume/hidden/exit/mount/unmount/terminal31frames; mocked audio boundary, no real listening proof');
