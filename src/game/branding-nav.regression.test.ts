import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import * as ts from 'typescript';

let checks = 0;
function check(value: unknown, message: string): asserts value { checks++; assert.ok(value, message); }
const home = readFileSync('src/screens/HomeScreen.tsx', 'utf8');
const app = readFileSync('src/App.tsx', 'utf8');
const paper = readFileSync('src/game/paperAssets.ts', 'utf8');
const source = ts.createSourceFile('HomeScreen.tsx', home, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declaration(name: string) {
  const node = source.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  check(!!node && ts.isFunctionDeclaration(node), `missing ${name} home contract`);
  return node;
}
const hero = declaration('HomeHero');
const routes: string[] = [];
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'nav') {
    check(node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]), 'Hero nav is conditionally gated/nonliteral');
    routes.push((node.arguments[0] as ts.StringLiteral).text);
  }
  ts.forEachChild(node, visit);
}
visit(hero);
for (const route of ['game', 'challenges', 'shop', 'leaderboard', 'referral', 'bonus', 'wallet']) {
  check(routes.includes(route), `Hero B lost menu action ${route}`);
}
check(!routes.includes('paywall'), 'Hero B restored an always-on run storefront');
check(/<ContextualCheckout/.test(app) && /refreshed\.dailyFreeLeft\s*\+\s*refreshed\.paidRuns\s*===\s*0/.test(app), 'App lost exhausted-admission contextual checkout');
check(!/disabled\s*=/.test(hero.getText(source)), 'Hero menu buttons disabled by quota');
check(/Practice/.test(hero.getText(source)), 'Hero B no longer exposes Practice');
check(/if\s*\(variant\s*===\s*1\)\s*return\s*<HomeHero/.test(home), 'variant B no longer selects HomeHero');
check(/const\s+HOME_VARIANT\s*=\s*1\s*;/.test(app), 'actual app no longer uses Hero B');
check(/variant=\{HOME_VARIANT\}/.test(app), 'actual app bypasses selected Home variant');
check(/branding\/wordmark\.png/.test(home), 'Home wordmark image path absent');
check(/branding\/wordmark\.png/.test(paper), 'loader does not include actual wordmark');
check(/SEEKER:\s*TD/.test(home), 'wordmark text fallback absent');
check(/status\s*===\s*['"]ready['"]/.test(home) && /role=['"]status['"]/.test(home), 'Home asset fallback/load-error notice absent');
const png = readFileSync('public/paper-assets/runtime/branding/wordmark.png');
check(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'wordmark is not PNG');
const manifest = JSON.parse(readFileSync('public/paper-assets/manifest.json', 'utf8')) as {
  branding: { wordmark: { canvas: number[] } };
};
check(png.readUInt32BE(16) * 2 === manifest.branding.wordmark.canvas[0]
  && png.readUInt32BE(20) * 2 === manifest.branding.wordmark.canvas[1], 'supplied half-resolution wordmark canvas mismatch');
console.log(`Branding/nav structural PASS: ${checks} checks; Hero B keeps six menu actions, setup and wallet; no browser claim.`);
