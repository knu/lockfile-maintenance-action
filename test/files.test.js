import assert from 'node:assert/strict';
import test from 'node:test';
import { selectFiles } from '../src/files.js';

test('matches basenames, recursive patterns and root anchors', () => {
  assert.ok(selectFiles('Cargo.lock')('a/b/Cargo.lock'));
  assert.ok(selectFiles('**/Cargo.lock')('Cargo.lock'));
  assert.ok(selectFiles('/Cargo.lock')('Cargo.lock'));
  assert.equal(selectFiles('/Cargo.lock')('a/Cargo.lock'), false);
  assert.equal(selectFiles('a/*/Cargo.lock')('a/b/c/Cargo.lock'), false);
  assert.ok(selectFiles('a/**/Cargo.lock')('a/b/c/Cargo.lock'));
});

test('uses ordered include/exclude rules, including directory reinclusion', () => {
  const select = selectFiles('Cargo.lock\n!vendor/\nvendor/keep/');
  assert.ok(select('Cargo.lock'));
  assert.equal(select('vendor/Cargo.lock'), false);
  assert.ok(select('vendor/keep/Cargo.lock'));
  assert.equal(selectFiles('!vendor/')('Cargo.lock'), false);
});

test('respects gitignore escaping, spaces, comments, character classes and CRLF', () => {
  const select = selectFiles(
    '# comment\r\n\r\n\\#app/\r\n\\!app/\r\nrust project/\r\napps/[ab]/Cargo.lock\r\n',
  );
  assert.equal(select('comment/Cargo.lock'), false);
  assert.ok(select('#app/Cargo.lock'));
  assert.ok(select('!app/Cargo.lock'));
  assert.ok(select('rust project/Cargo.lock'));
  assert.ok(select('apps/a/Cargo.lock'));
  assert.equal(select('apps/c/Cargo.lock'), false);
  assert.equal(selectFiles('Cargo.lock')('cargo.lock'), false);
  assert.equal(selectFiles('Cargo.lock\n!#app/')('#app/Cargo.lock'), false);
  assert.equal(selectFiles('Cargo.lock\n!!app/')('!app/Cargo.lock'), false);
});
