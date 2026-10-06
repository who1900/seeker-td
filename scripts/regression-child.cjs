const fs = require('node:fs');
const path = require('node:path');

let networkAttempted = false;
process.on('exit', () => { if (networkAttempted) process.exitCode = 1; });
function denyNetwork() {
  networkAttempted = true;
  process.exitCode = 1;
  throw new Error('REGRESSION_REAL_NETWORK_BLOCKED');
}
for (const name of ['node:http', 'node:https']) {
  const module = require(name);
  module.request = module.get = denyNetwork;
}
require('node:net').Socket.prototype.connect = denyNetwork;
const dgram = require('node:dgram');
dgram.Socket.prototype.send = dgram.Socket.prototype.connect = denyNetwork;
globalThis.fetch = async () => denyNetwork();

const suite = path.resolve(process.argv[2]);
if (!/\.test\.(ts|tsx|cjs)$/.test(suite) || !fs.statSync(suite).isFile()) {
  throw new Error('REGRESSION_INVALID_SUITE');
}
if (/\.tsx?$/.test(suite)) {
  const ts = require('typescript');
  for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => {
    const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename,
      reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
        jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    });
    const errors = result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error) ?? [];
    if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
      getCurrentDirectory: () => process.cwd(), getCanonicalFileName: f => f, getNewLine: () => '\n',
    }));
    module._compile(result.outputText, filename);
  };
}
require(suite);
