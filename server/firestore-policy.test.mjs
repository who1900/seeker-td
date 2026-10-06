import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
const expected = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /players/{uid} {
      allow read: if true;
      allow create, update, delete: if false;
    }
    match /{document=**} {
      allow read, write: if false;
    }
  }
}`;
const normalize = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '').replace(/\s+/g, '');
const matchesPolicy = source => normalize(source) === normalize(expected);

test('source policy is exactly public players read + client-write deny + recursive default deny', () => {
  assert.equal(matchesPolicy(rules), true);
  const statements = rules.match(/\ballow\s+[^;]+;/g);
  assert.deepEqual(statements?.map(normalize), [
    'allowread:iftrue;', 'allowcreate,update,delete:iffalse;', 'allowread,write:iffalse;',
  ]);
});

test('source guard rejects permissive writes, extra matching allows and private reads', () => {
  const mutations = [
    rules.replace('allow create, update, delete: if false;', 'allow create, update, delete: if true;'),
    rules.replace('allow create, update, delete: if false;', 'allow create, update, delete: if request.auth != null;'),
    rules.replace('allow read, write: if false;', 'allow read, write: if true;'),
    rules.replace('allow read, write: if false;', 'allow read: if true; allow write: if false;'),
    rules.replace('allow read: if true;', 'allow read: if false;'),
    rules.replace('match /players/{uid}', 'match /{document=**}'),
    rules.replace('match /{document=**}', 'match /{document}'),
    rules.replace('allow read: if true;', 'allow read: if true; allow update: if true;'),
    `${rules}\nmatch /trust/{id} { allow read, write: if true; }`,
  ];
  for (const mutation of mutations) assert.equal(matchesPolicy(mutation), false);
});
