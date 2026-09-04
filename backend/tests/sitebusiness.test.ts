import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';
import { createGateway } from '../src/api/gateway.ts';
import { Platform } from '../src/platform.ts';
import {
  addressBlock,
  contactColumn,
  organisationJsonLd,
  phoneLink,
  socialLabel,
  socialLinks,
  telHref,
  type BusinessDetails,
} from '../src/site/business.ts';

/**
 * The business behind the public site — phone, email, address, profiles —
 * and where it appears. An audit of the live site found none of it, and the
 * one cause was that the site had nowhere to hold any of it. Two rules are
 * tested here: what is configured appears everywhere at once, and what is not
 * configured is not invented.
 */

const FULL: BusinessDetails = {
  legalName: 'Construx Ventures Group Ltd',
  email: 'contact@construxvg.com',
  phone: '+44 (0)20 7946 0000',
  address: { street: '1 Example Street', locality: 'London', region: '', postcode: 'EC1A 1AA', country: 'GB' },
  social: ['https://www.linkedin.com/company/construx', 'https://x.com/construx', 'https://example.org/us'],
  openingHours: ['Mo-Fr 09:00-17:30'],
};

const BARE: BusinessDetails = { legalName: 'CONSTRUX', email: 'contact@construxvg.com', phone: '', address: null, social: [], openingHours: [] };

describe('a number a phone can dial', () => {
  it('strips what people write and keeps the plus', () => {
    assert.equal(telHref('+44 (0)20 7946 0000'), 'tel:+4402079460000');
    assert.equal(telHref('020 7946 0000'), 'tel:02079460000');
    assert.equal(telHref('+1-212-555-0100'), 'tel:+12125550100');
  });

  it('shows nothing where no phone is configured', () => {
    assert.equal(phoneLink(BARE), '');
    assert.match(phoneLink(FULL), /^<a class="head-phone" href="tel:\+440207946000\d">/);
  });
});

describe('profiles named by their host', () => {
  it('recognises the usual networks and falls back to the host', () => {
    assert.equal(socialLabel('https://www.linkedin.com/company/construx'), 'LinkedIn');
    assert.equal(socialLabel('https://x.com/construx'), 'X');
    assert.equal(socialLabel('https://twitter.com/construx'), 'X');
    assert.equal(socialLabel('https://example.org/us'), 'example.org');
    assert.equal(socialLabel('not a url'), 'not a url');
  });

  it('links each with rel=me, and renders nothing for none', () => {
    assert.equal(socialLinks(BARE), '');
    const html = socialLinks(FULL);
    assert.equal((html.match(/rel="me noopener"/g) ?? []).length, 3);
    assert.ok(html.includes('>LinkedIn<'));
  });
});

describe('structured data', () => {
  it('is an Organization carrying only what is configured', () => {
    const bare = organisationJsonLd(BARE, 'https://construxvg.com/');
    assert.equal(bare['@type'], 'Organization');
    assert.equal(bare.url, 'https://construxvg.com/');
    assert.equal(bare.email, 'contact@construxvg.com');
    assert.equal('telephone' in bare, false, 'no phone is invented');
    assert.equal('address' in bare, false);
    assert.equal('sameAs' in bare, false);

    const full = organisationJsonLd(FULL, 'https://construxvg.com');
    assert.equal(full.telephone, FULL.phone);
    assert.deepEqual(full.address, {
      '@type': 'PostalAddress',
      streetAddress: '1 Example Street',
      addressLocality: 'London',
      postalCode: 'EC1A 1AA',
      addressCountry: 'GB',
    });
    assert.deepEqual(full.sameAs, FULL.social);
    assert.deepEqual(full.openingHours, ['Mo-Fr 09:00-17:30']);
    assert.equal(full.legalName, 'Construx Ventures Group Ltd');
  });
});

describe('the footer column', () => {
  it('always carries the email, and the rest only when set', () => {
    const bare = contactColumn(BARE);
    assert.ok(bare.includes('href="mailto:contact@construxvg.com"'));
    assert.equal(bare.includes('tel:'), false);
    assert.equal(bare.includes('<address'), false);
    assert.equal(bare.includes('Elsewhere'), false);

    const full = contactColumn(FULL);
    assert.ok(full.includes('href="tel:'));
    assert.ok(full.includes('<address class="postal">1 Example Street<br>London<br>EC1A 1AA</address>'));
    assert.ok(full.includes('Elsewhere'));
  });

  it('escapes what it prints', () => {
    const hostile = { ...FULL, address: { ...FULL.address!, street: '<script>alert(1)</script>' } };
    assert.equal(addressBlock(hostile).includes('<script>'), false);
  });
});

describe('on the served pages, with nothing configured beyond the defaults', () => {
  let server: Server;
  let base: string;

  before(async () => {
    server = createGateway(new Platform());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(() => server.close());

  for (const path of ['/', '/about', '/contact']) {
    it(`${path} carries a contact route and Organization structured data, and invents no phone`, async () => {
      const html = await (await fetch(`${base}${path}`)).text();
      assert.ok(html.includes('href="mailto:contact@construxvg.com"'), `${path}: no email link`);
      assert.equal(html.includes('href="tel:'), false, `${path}: a phone was invented`);
      const blocks = [...html.matchAll(/<script type="application\/ld\+json">([^<]+)<\/script>/g)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>);
      const organisation = blocks.find((block) => block['@type'] === 'Organization');
      assert.ok(organisation, `${path}: no Organization structured data`);
      assert.equal(organisation['@context'], 'https://schema.org');
      assert.equal(organisation.email, 'contact@construxvg.com');
    });
  }

  it('/contact names the email as a link a mail client opens', async () => {
    const html = await (await fetch(`${base}/contact`)).text();
    assert.ok(html.includes('<dl class="contact-details">'));
    assert.ok(html.includes('<dt>Email</dt>'));
    assert.equal(html.includes('<dt>Call</dt>'), false);
  });
});
