// Closed subset of markdown: ATX h1/h2, an effective-date line, and wrapped
// paragraphs. Anything else is refused so the in-app render cannot silently
// drop a link, list or heading the document grew later.

export const PRIVACY_NOTICE_RELATIVE_PATH = 'docs/legal/privacy-notice.md';

const FORBIDDEN = Object.freeze([
  {
    pattern: /\[[^\]]+\]\([^)]*\)/u,
    message: 'Privacy notice must not contain markdown links.',
  },
  {
    pattern: /https?:\/\//iu,
    message: 'Privacy notice must not contain external URLs.',
  },
  {
    pattern: /<[a-zA-Z/!?]/u,
    message: 'Privacy notice must not contain HTML.',
  },
  {
    pattern: /^#{3,}/mu,
    message: 'Privacy notice headings deeper than level 2 are not rendered.',
  },
  {
    pattern: /^```/mu,
    message: 'Privacy notice must not contain fenced code.',
  },
  {
    pattern: /^[ \t]*[-*+] /mu,
    message: 'Privacy notice must not contain lists.',
  },
  {
    pattern: /^[ \t]*\d+\. /mu,
    message: 'Privacy notice must not contain lists.',
  },
]);

function unwrap(block) {
  return block.split('\n').map((line) => line.trim()).join(' ');
}

function assertRenderableMarkdown(markdown) {
  if (typeof markdown !== 'string' || markdown.trim() === '') {
    throw new TypeError('Privacy notice markdown is required.');
  }
  if (markdown.includes('\r')) {
    throw new TypeError('Privacy notice must use Unix line endings.');
  }
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(markdown)) throw new TypeError(rule.message);
  }
}

export function parsePrivacyNotice(markdown) {
  assertRenderableMarkdown(markdown);
  const blocks = markdown.replace(/\n+$/u, '').split(/\n\n+/u);
  if (blocks.length < 4) {
    throw new TypeError('Privacy notice is incomplete.');
  }

  const titleMatch = /^# (.+)$/u.exec(blocks[0]);
  if (!titleMatch || blocks[0].includes('\n')) {
    throw new TypeError('Privacy notice must start with a single-line level-1 heading.');
  }

  const dateMatch = /^Effective date: (.+)$/u.exec(blocks[1]);
  if (!dateMatch || blocks[1].includes('\n')) {
    throw new TypeError('Privacy notice must declare a single-line effective date.');
  }
  if (!/^\d{1,2} [A-Z][a-z]+ \d{4}$/u.test(dateMatch[1])) {
    throw new TypeError('Privacy notice effective date must follow "D Month YYYY".');
  }

  const preamble = [];
  let index = 2;
  while (index < blocks.length && !blocks[index].startsWith('## ')) {
    preamble.push(unwrap(blocks[index]));
    index += 1;
  }
  if (preamble.length === 0) {
    throw new TypeError('Privacy notice must have preamble text before the first section.');
  }

  const sections = [];
  while (index < blocks.length) {
    const headingMatch = /^## (.+)$/u.exec(blocks[index]);
    if (!headingMatch || blocks[index].includes('\n')) {
      throw new TypeError('Privacy notice sections must start with a single-line level-2 heading.');
    }
    index += 1;
    const paragraphs = [];
    while (index < blocks.length && !blocks[index].startsWith('## ')) {
      paragraphs.push(unwrap(blocks[index]));
      index += 1;
    }
    if (paragraphs.length === 0) {
      throw new TypeError(`Privacy notice section "${headingMatch[1]}" has no paragraphs.`);
    }
    sections.push(Object.freeze({
      heading: headingMatch[1],
      paragraphs: Object.freeze(paragraphs),
    }));
  }
  if (sections.length === 0) {
    throw new TypeError('Privacy notice must contain at least one section.');
  }

  return Object.freeze({
    title: titleMatch[1],
    effectiveDate: dateMatch[1],
    preamble: Object.freeze(preamble),
    sections: Object.freeze(sections),
  });
}

export function privacyNoticeProse(notice) {
  return Object.freeze([
    notice.title,
    `Effective date: ${notice.effectiveDate}`,
    ...notice.preamble,
    ...notice.sections.flatMap((section) => [section.heading, ...section.paragraphs]),
  ]);
}
