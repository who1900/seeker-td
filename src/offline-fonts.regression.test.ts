import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import * as ts from 'typescript';

let checks = 0;
function check(value: unknown, message: string): asserts value { checks++; assert.ok(value, message); }
const styles = readFileSync('src/styles.css', 'utf8');
check(/@import\s+['"]\.\/fonts\.css['"]/.test(styles), 'local font faces not imported by app styles');
const css = styles + '\n' + readFileSync('src/fonts.css', 'utf8');
const index = readFileSync('index.html', 'utf8');
check(!/fonts\.(?:googleapis|gstatic)\.com/i.test(css + index), 'Google fonts links remain in app entry/styles');
check(!/@import\s+(?:url\()?\s*['"]?https?:/i.test(css), 'remote stylesheet import remains');
const faces = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(match => match[1]);
check(faces.length >= 4, 'local font faces missing');
const families = ['Instrument Sans', 'Instrument Serif', 'JetBrains Mono', 'Caveat'];
const visited = new Set<string>();
for (const family of families) {
  const familyFaces = faces.filter(face => new RegExp(`font-family\\s*:\\s*['"]${family}['"]`).test(face));
  check(familyFaces.length > 0, `${family}: local family absent`);
  for (const weight of family === 'Instrument Serif' ? [400] : family === 'JetBrains Mono' ? [400, 500, 700] : [400, 500, 600, 700]) {
    check(familyFaces.some(face => {
      const value = /font-weight\s*:\s*([^;]+)/.exec(face)?.[1].trim();
      const values = value?.match(/\d+/g)?.map(Number) ?? [];
      return values.length === 1 ? values[0] === weight : values.length === 2 && values[0] <= weight && values[1] >= weight;
    }), `${family}: missing weight ${weight}`);
  }
  if (family === 'Instrument Serif') check(familyFaces.some(face => /font-style\s*:\s*italic/.test(face)), 'Instrument Serif italic absent');
}
function font(file: string, family: string, weights: number[]) {
  if (visited.has(file)) return;
  visited.add(file);
  const data = readFileSync(file);
  check(data.length >= 48, `${file}: truncated font`);
  const magic = data.subarray(0, 4).toString('ascii');
  if (magic === 'wOFF' || magic === 'wOF2') {
    check(data.readUInt32BE(8) === data.length && data.readUInt16BE(12) > 0 && data.readUInt16BE(14) === 0,
      `${file}: invalid WOFF header/length`);
    check(data.readUInt32BE(16) > 0, `${file}: empty SFNT payload`);
    if (magic === 'wOFF') {
      const count = data.readUInt16BE(12);
      check(44 + count * 20 <= data.length, `${file}: truncated WOFF directory`);
      for (let i = 0; i < count; i++) {
        const offset = 44 + i * 20;
        const start = data.readUInt32BE(offset + 4), compressed = data.readUInt32BE(offset + 8), original = data.readUInt32BE(offset + 12);
        check(start >= 44 + count * 20 && start + compressed <= data.length && compressed > 0 && original >= compressed,
          `${file}: invalid WOFF table`);
      }
    } else check(data.readUInt32BE(20) > 0 && data.readUInt32BE(20) < data.length, `${file}: invalid WOFF2 compressed size`);
  } else {
    check(data.readUInt32BE(0) === 0x00010000 || magic === 'OTTO' || magic === 'true', `${file}: invalid SFNT magic`);
    const count = data.readUInt16BE(4);
    check(count > 0 && 12 + count * 16 <= data.length, `${file}: invalid SFNT directory`);
    const tables = new Map<string, { start: number; length: number }>();
    for (let i = 0; i < count; i++) {
      const offset = 12 + i * 16, start = data.readUInt32BE(offset + 8), length = data.readUInt32BE(offset + 12);
      tables.set(data.subarray(offset, offset + 4).toString('ascii'), { start, length });
      check(start >= 12 + count * 16 && start + length <= data.length, `${file}: SFNT table outside payload`);
    }
    check(['head', 'name', 'cmap'].every(table => tables.has(table)), `${file}: required SFNT tables missing`);
    const names = tables.get('name')!;
    const nameCount = data.readUInt16BE(names.start + 2), storage = data.readUInt16BE(names.start + 4);
    check(6 + nameCount * 12 <= names.length && storage < names.length, `${file}: invalid name records`);
    const actualFamilies: string[] = [];
    for (let i = 0; i < nameCount; i++) {
      const record = names.start + 6 + i * 12;
      const platform = data.readUInt16BE(record), id = data.readUInt16BE(record + 6);
      if (id !== 1 && id !== 16) continue;
      const length = data.readUInt16BE(record + 8), offset = data.readUInt16BE(record + 10);
      check(storage + offset + length <= names.length, `${file}: family name outside name table`);
      const bytes = Buffer.from(data.subarray(names.start + storage + offset, names.start + storage + offset + length));
      if (platform === 0 || platform === 3) {
        check(bytes.length % 2 === 0, `${file}: malformed UTF16 family`);
        actualFamilies.push(bytes.swap16().toString('utf16le'));
      } else if (platform === 1) actualFamilies.push(bytes.toString('ascii'));
    }
    check(actualFamilies.includes(family), `${file}: binary family does not match CSS ${family}`);
    const variable = tables.get('fvar');
    if (variable) {
      const offset = data.readUInt16BE(variable.start + 4), count = data.readUInt16BE(variable.start + 8), size = data.readUInt16BE(variable.start + 10);
      check(size >= 20 && offset + count * size <= variable.length, `${file}: invalid variable axis table`);
      const axes = Array.from({ length: count }, (_, i) => variable.start + offset + i * size);
      const weight = axes.find(axis => data.subarray(axis, axis + 4).toString('ascii') === 'wght');
      check(weight !== undefined, `${file}: variable font lacks weight axis`);
      const min = data.readInt32BE(weight + 4) / 65536, max = data.readInt32BE(weight + 12) / 65536;
      check(weights.every(value => value >= min && value <= max), `${file}: CSS weight outside actual variable axis`);
    } else {
      const os2 = tables.get('OS/2');
      check(!!os2 && os2.length >= 6, `${file}: static weight table absent`);
      check(weights.every(value => value === data.readUInt16BE(os2.start + 4)), `${file}: static font weight does not match CSS`);
    }
  }
}
for (const face of faces) {
  check(/font-display\s*:\s*(?:swap|fallback|optional)/.test(face), 'font face may blank/block offline text');
  const urls = [...face.matchAll(/url\(\s*['"]?([^'"\)]+)['"]?\s*\)/g)].map(match => match[1]);
  const family = /font-family\s*:\s*['"]([^'"]+)['"]/.exec(face)?.[1];
  const weights = /font-weight\s*:\s*([^;]+)/.exec(face)?.[1].match(/\d+/g)?.map(Number) ?? [];
  check(!!family && weights.length > 0, 'font face missing explicit family/weight');
  check(urls.length > 0, 'font face has no packaged URL');
  for (const url of urls) {
    check(!/^(?:https?:|\/\/|data:)/i.test(url), `font is not packaged locally: ${url}`);
    const clean = url.replace(/^\//, '').split(/[?#]/)[0];
    const file = url.startsWith('/') ? resolve('public', clean) : resolve('src', clean);
    check(existsSync(file), `packaged font URL missing: ${url}`);
    font(file, family, weights);
  }
}
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}
const licenses = files('public/fonts').filter(file => /(?:ofl|license)/i.test(basename(file)));
check(licenses.length >= 4, 'font licenses absent/incomplete');
for (const license of licenses) {
  const text = readFileSync(license, 'utf8');
  check(/SIL OPEN FONT LICENSE|Apache License/i.test(text) && /Copyright/i.test(text), `${license}: license text invalid/missing copyright`);
}
const cap = readFileSync('capacitor.config.ts', 'utf8');
const capSource = ts.createSourceFile('capacitor.config.ts', cap, ts.ScriptTarget.Latest, true);
function inspect(node: ts.Node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(capSource).replace(/['"]/g, '') === 'server') {
    check(ts.isObjectLiteralExpression(node.initializer), 'production server config is not auditable literal');
    for (const prop of node.initializer.properties) if (ts.isPropertyAssignment(prop)) {
      const name = prop.name.getText(capSource).replace(/['"]/g, '');
      check(name !== 'url', 'production server.url enables remote app content');
      if (name === 'allowNavigation') {
        check(ts.isArrayLiteralExpression(prop.initializer), 'allowNavigation not an explicit host array');
        check(prop.initializer.elements.every(item => ts.isStringLiteral(item) && !item.text.includes('*')
          && /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(item.text)), 'wildcard/remote navigation enabled');
      }
    }
  }
  ts.forEachChild(node, inspect);
}
inspect(capSource);
console.log(`Offline fonts/cap structural PASS: ${visited.size} packaged fonts, ${licenses.length} licenses, ${checks} checks; no offline browser claim.`);
