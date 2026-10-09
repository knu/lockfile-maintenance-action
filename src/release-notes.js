import { Marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

const markdown = new Marked({ gfm: true });

export function releaseNotes(body) {
  const html = sanitizeHtml(markdown.parse(body), {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'samp', 'kbd'],
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      code: ['class'],
    },
    disallowedTagsMode: 'escape',
    textFilter: (text, tag) =>
      ['code', 'pre'].includes(tag) ? text : text.replaceAll('@', '@\u200b'),
  });
  return `<blockquote>\n${html.trim()}\n</blockquote>`;
}
