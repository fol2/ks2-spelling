import privacyNoticeMarkdown from 'virtual:privacy-notice';
import { parsePrivacyNotice } from './privacy-notice-document.js';

export function PrivacyNoticeCard() {
  const notice = parsePrivacyNotice(privacyNoticeMarkdown);
  return (
    <section className="paper-card parent-card" aria-labelledby="parent-privacy-title">
      <p className="product-kicker">About this app</p>
      <h2 id="parent-privacy-title">{notice.title}</h2>
      <p>Effective date: {notice.effectiveDate}</p>
      {notice.preamble.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
      {notice.sections.map((section) => (
        <section key={section.heading} className="privacy-notice-section">
          <h3>{section.heading}</h3>
          {section.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </section>
      ))}
      <details>
        <summary>Third-party notices</summary>
        <p>
          KS2 Spelling uses audited open-source application and platform
          libraries. The release distribution includes their identity,
          source and licence notice inventory.
        </p>
      </details>
    </section>
  );
}
