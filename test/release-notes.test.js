import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseNotes } from '../src/release-notes.js';

test('entities and safe inline formatting retain their meaning', () => {
  const body = releaseNotes(
    '### &nbsp;🐞 Bug Fixes\n\nFix &nbsp;-&nbsp; by @author [<samp>(607e8)</samp>](https://example.com/commit?a=1&b=2)',
  );
  assert.ok(body.includes('\u00a0'));
  assert.ok(!body.includes('&amp;nbsp;'));
  assert.ok(!body.includes('&#38;nbsp;'));
  assert.match(body, /<samp>\(607e8\)<\/samp>/);
  assert.match(body, /href="https:\/\/example.com\/commit\?a=1&amp;b=2"/);
  assert.match(body, /@\u200bauthor/);
});

test('HTML examples in code remain literal and mentions do not become raw text', () => {
  const body = releaseNotes(
    '`<samp>&nbsp;</samp>`\n\n```js\na < b && c > d\nconst email = "user@example.com";\n```',
  );
  assert.match(body, /<code>&lt;samp&gt;&amp;nbsp;&lt;\/samp&gt;<\/code>/);
  assert.match(body, /a &lt; b &amp;&amp; c &gt; d/);
  assert.match(body, /user@example.com/);
});

test('upstream HTML cannot close enclosing controls or introduce active content', () => {
  const body = releaseNotes(
    '</blockquote></details></td>\n\n<samp onclick="alert(1)">safe</samp><a href="javascript:alert(1)">link</a><script>alert(1)</script>',
  );
  assert.ok(!body.includes('</details>'));
  assert.ok(!body.includes('</td>'));
  assert.ok(!body.includes('<script>'));
  assert.ok(!body.includes('onclick='));
  assert.ok(!body.includes('javascript:'));
  assert.match(body, /<samp>safe<\/samp>/);
  assert.equal(body.split('</blockquote>').length - 1, 1);
});
