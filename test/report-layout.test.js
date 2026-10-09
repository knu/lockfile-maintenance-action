import assert from 'node:assert/strict';
import test from 'node:test';
import { Marked } from 'marked';
import { maintainLockfile } from '../src/maintenance.js';
import { changeReport } from '../src/version-changes.js';

function files(body = 'Release notes') {
  const history = {
    versionUrls: {
      '1.0.0': 'https://github.com/org/repo/tree/v1.0.0',
      '1.1.0': 'https://github.com/org/repo/releases/tag/v1.1.0',
    },
    compareUrl: 'https://github.com/org/repo/compare/v1.0.0...v1.1.0',
    releasesUrl: 'https://github.com/org/repo/releases',
    releases: [{ tag: 'v1.1.0', url: 'https://github.com/org/repo/releases/tag/v1.1.0', body }],
  };
  return ['first/package-lock.json', 'second/package-lock.json'].map((file) => ({
    file,
    changes: [{ name: 'example', from: ['1.0.0'], to: ['1.1.0'], history }],
  }));
}

test('separate is the default, links both ways, and targets named anchors inside closed details', () => {
  const report = changeReport(files(), '3 days');
  assert.ok(report.indexOf('second/package') < report.indexOf('<details>'));
  assert.match(report, /\[<code>1.0.0<\/code>\]\(https:\/\/github.com\/org\/repo\/tree\/v1.0.0\)/);
  assert.match(
    report,
    /\[<code>1.1.0<\/code>\]\(https:\/\/github.com\/org\/repo\/releases\/tag\/v1.1.0\)/,
  );
  assert.ok(!report.includes('<a id=') && !report.includes('<details open'));
  for (const index of [1, 2]) {
    assert.match(report, new RegExp(`\\[Release history\\]\\(#history-${index}-1\\)`));
    assert.match(
      report,
      new RegExp(`<details>\\s*<summary>[^]*?</summary>\\s*<a name="history-${index}-1"></a>`),
    );
    assert.match(report, new RegExp(`\\[Back to version changes\\]\\(#versions-${index}\\)`));
  }
});

test('inline renders linked versions and collapsible history inside a spanning table cell', () => {
  const report = changeReport(files(), '3 days', 60000, 'inline');
  const html = new Marked({ gfm: true }).parse(report);
  assert.match(
    html,
    /<td><a href="https:\/\/github.com\/org\/repo\/tree\/v1.0.0"><code>1.0.0<\/code><\/a><\/td>/,
  );
  assert.match(html, /<tr><td colspan="4">\s*<details>/);
  assert.match(html, /<h4><a href="https:\/\/github.com\/org\/repo\/releases\/tag\/v1.1.0">/);
  assert.match(html, /<blockquote>\s*<p>Release notes<\/p>/);
  assert.match(html, /<\/details>\s*<\/td><\/tr>\s*<\/tbody>\s*<\/table>/);
});

for (const layout of ['separate', 'inline']) {
  test(`${layout} keeps containers and link targets intact when notes or rows are omitted`, () => {
    const many = files('あ'.repeat(30000));
    many[0].changes = Array.from({ length: 100 }, () => many[0].changes[0]);
    for (const limit of [1200, 4000, 60000]) {
      const report = changeReport(many, '3 days', limit, layout);
      assert.ok(Buffer.byteLength(report) <= limit);
      assert.match(report, /Report truncated/);
      assert.equal(report.match(/<details>/g)?.length, report.match(/<\/details>/g)?.length);
      assert.equal(report.match(/<table>/g)?.length, report.match(/<\/table>/g)?.length);
      for (const [, id] of report.matchAll(/\]\(#([^)]*)\)/g))
        assert.ok(report.includes(`name="${id}"`), `missing target ${id}`);
    }
  });
}

test('invalid layout is rejected before accessing the workspace or running managers', async () => {
  assert.throws(() => changeReport([], '3 days', 60000, 'other'), /release-history-layout/);
  await assert.rejects(
    maintainLockfile({ INPUT_RELEASE_HISTORY_LAYOUT: 'other' }),
    /release-history-layout/,
  );
});
