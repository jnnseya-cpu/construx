import { config } from '../config.ts';
import { esc } from '../messaging/render.ts';

/**
 * The business behind the public site: how to reach it, where it is, and
 * where else it can be checked out.
 *
 * Every value comes from configuration. None is invented: a phone number that
 * is not set is not shown, and a page with no phone is an honest page where a
 * page with a made-up one is a lie a customer dials. The audit that prompted
 * this measured the live site and found no phone, no contact link, no address,
 * no social profile and no structured data — five findings with one cause: the
 * site had nowhere to hold any of it.
 *
 * What is set appears in three places at once, so it cannot drift: the header
 * and footer of every page, the contact page, and `Organization` structured
 * data in the head of every page. Search engines read the last; people read
 * the first two.
 */

export type PostalAddress = {
  street: string;
  locality: string;
  region: string;
  postcode: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
};

export type BusinessDetails = {
  legalName: string;
  email: string;
  /** As displayed. Empty when not configured. */
  phone: string;
  address: PostalAddress | null;
  /** Public profile URLs, in the order given. */
  social: string[];
  /** schema.org `openingHours` strings, e.g. `Mo-Fr 09:00-17:30`. */
  openingHours: string[];
};

export function businessDetails(): BusinessDetails {
  const site = config.site.business;
  const address =
    site.addressStreet && site.addressLocality && site.addressPostcode
      ? {
          street: site.addressStreet,
          locality: site.addressLocality,
          region: site.addressRegion,
          postcode: site.addressPostcode,
          country: site.addressCountry,
        }
      : null;
  return {
    legalName: site.legalName,
    email: site.email,
    phone: site.phone,
    address,
    social: site.social,
    openingHours: site.openingHours,
  };
}

/**
 * A number a phone can dial, from the number a person reads.
 *
 * `tel:` wants digits and a leading `+`; spaces, brackets and dashes are what
 * people write and what a dialler cannot use. A `0`-prefixed national number
 * is passed through as written rather than guessed into an international one —
 * the country is not known here, and a wrong guess dials somebody else.
 */
export function telHref(phone: string): string {
  const compact = phone.replace(/[^\d+]/g, '');
  return `tel:${compact.startsWith('+') ? `+${compact.slice(1).replace(/\+/g, '')}` : compact}`;
}

const SOCIAL_LABELS: ReadonlyArray<{ host: RegExp; label: string }> = [
  { host: /(^|\.)linkedin\.com$/, label: 'LinkedIn' },
  { host: /(^|\.)(x|twitter)\.com$/, label: 'X' },
  { host: /(^|\.)youtube\.com$/, label: 'YouTube' },
  { host: /(^|\.)instagram\.com$/, label: 'Instagram' },
  { host: /(^|\.)facebook\.com$/, label: 'Facebook' },
  { host: /(^|\.)tiktok\.com$/, label: 'TikTok' },
  { host: /(^|\.)github\.com$/, label: 'GitHub' },
];

/** The name a person recognises for a profile link, from its host. */
export function socialLabel(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return SOCIAL_LABELS.find((entry) => entry.host.test(host))?.label ?? host;
  } catch {
    return url;
  }
}

/**
 * The organisation, as schema.org structured data, carrying only what is
 * configured. `Organization` rather than `LocalBusiness`: a software platform
 * is not a shop with a door, and claiming to be one would be marked up as a
 * falsehood by the same crawler the markup is for.
 */
export function organisationJsonLd(details: BusinessDetails, baseUrl: string): Record<string, unknown> {
  const base = baseUrl.replace(/\/$/, '');
  const out: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'CONSTRUX',
    legalName: details.legalName,
    url: `${base}/`,
    logo: `${base}/logo.svg`,
    email: details.email,
    contactPoint: [
      {
        '@type': 'ContactPoint',
        contactType: 'sales',
        email: details.email,
        ...(details.phone ? { telephone: details.phone } : {}),
        availableLanguage: 'en',
      },
    ],
  };
  if (details.phone) out.telephone = details.phone;
  if (details.address) {
    out.address = {
      '@type': 'PostalAddress',
      streetAddress: details.address.street,
      addressLocality: details.address.locality,
      ...(details.address.region ? { addressRegion: details.address.region } : {}),
      postalCode: details.address.postcode,
      addressCountry: details.address.country,
    };
  }
  if (details.social.length) out.sameAs = details.social;
  if (details.openingHours.length) out.openingHours = details.openingHours;
  return out;
}

/** The phone as a tappable link, or nothing. Header-sized. */
export function phoneLink(details: BusinessDetails, className = 'head-phone'): string {
  if (!details.phone) return '';
  return `<a class="${esc(className)}" href="${esc(telHref(details.phone))}">${esc(details.phone)}</a>`;
}

/** The email as a link that opens a message. */
export function emailLink(details: BusinessDetails): string {
  return `<a href="mailto:${esc(details.email)}">${esc(details.email)}</a>`;
}

/** The postal address as an `<address>` block, or nothing. */
export function addressBlock(details: BusinessDetails): string {
  const a = details.address;
  if (!a) return '';
  const lines = [a.street, a.locality, a.region, a.postcode].filter((line) => line).map((line) => esc(line));
  return `<address class="postal">${lines.join('<br>')}</address>`;
}

/** Links to the configured profiles, each named by its host, or nothing. */
export function socialLinks(details: BusinessDetails): string {
  if (!details.social.length) return '';
  return `<ul class="social">${details.social
    .map((url) => `<li><a href="${esc(url)}" rel="me noopener" target="_blank">${esc(socialLabel(url))}</a></li>`)
    .join('')}</ul>`;
}

/**
 * The footer's contact column: what is configured, in the order a person
 * looks for it. Always at least the email, because an address that exists is
 * the one route the audit could not find.
 */
export function contactColumn(details: BusinessDetails): string {
  const rows = [
    details.phone ? `<li>${phoneLink(details, 'foot-phone')}</li>` : '',
    `<li>${emailLink(details)}</li>`,
    details.address ? `<li>${addressBlock(details)}</li>` : '',
  ].filter((row) => row);
  const social = details.social.length ? `<h4>Elsewhere</h4>${socialLinks(details)}` : '';
  return `<div class="foot-contact"><h4>Contact</h4><ul>${rows.join('')}</ul>${social}</div>`;
}
