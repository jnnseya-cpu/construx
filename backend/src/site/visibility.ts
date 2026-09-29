import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { FEATURES, type Feature } from '../messaging/content.ts';
import { esc } from '../messaging/render.ts';
import { sendMail, type SmtpOptions } from '../messaging/smtp.ts';
import { PLATFORM_TENANT_ID, type Platform } from '../platform.ts';
import type { RequestContext } from '../api/middleware.ts';
import { hyperlink, postUrl, SHARE_CHANNELS, shareTargets, wordsOf } from './article.ts';
import {
  BLOG_PROJECT_ID,
  type BlogPost,
  commitPost,
  type PostActor,
  posts,
  publishAs,
  publishedPosts,
  SEO,
  seoReport,
  seoScore,
  uniqueSlug,
} from './blog.ts';
import { llms, robots, sitemap } from './discovery.ts';
import { POST_PAGES, render, renderLanding, SITE_PAGES } from './index.ts';
import { mediaState } from './media.ts';
import { POSTS } from './posts.ts';
import { engagementFor, viewsPosition } from './views.ts';

/**
 * The visibility engine: what the public site looks like from outside, and the
 * marketing agent that keeps it moving.
 *
 * `blog.ts` governs one post at a time — its checks, its gate, its record. This
 * module reads the site as a whole and acts on the whole: a sweep of the
 * twelve things a crawler, a link preview, a search result and an answer
 * engine actually look for, each checked against the rendered markup or the
 * served file rather than against a
 * checklist; the reach the pages have had; where a post can be sent and where
 * it has been; a composer that writes a post from the feature catalogue; a
 * library of one post per topic; and a daily release that runs once a day and
 * says what it did.
 *
 * Four rules hold, and each is the reason a line below is shaped the way it is.
 *
 * **Every check reads the real thing.** The sweep renders the pages and reads
 * their heads; it parses the sitemap it would serve; it stats the hero image.
 * A check that reads a flag saying "hreflang: on" is a check that passes while
 * the page is broken.
 *
 * **The template says only what the product already says.** `composePost`
 * assembles a post from `FEATURES` — the sentences the newsletter already sends
 * about capabilities that exist and link to screens that serve them — around a
 * topic and a keyword. It invents no figure, no customer and no claim. That is
 * what makes it the one authorship allowed to publish without a person: every
 * sentence was a published sentence before the post existed. A *model's* prose
 * still lands as a draft a person publishes, exactly as `draftPost` insists.
 *
 * **A channel is either configured or it is absent — never pretend.** Each
 * outside channel names the variable it is missing. Nothing is queued for a
 * channel with no credential, and a send that the network refused is on the
 * record as refused, with the network's answer.
 *
 * **Once a day means once a day.** The release is keyed by UTC date on the
 * chain. The timer and the button both ask the record first, so a restart at
 * 08:59 and a press at 09:01 produce one release, not two.
 */

// --- Topics -------------------------------------------------------------------

export type Topic = {
  id: string;
  /** The article's title, which carries the keyword — the gate requires it. */
  title: string;
  /** The phrase the post is meant to be found by. */
  keyword: string;
  /** The category the post is filed under, and the coverage check reads. */
  tag: string;
  /** Which entries of the feature catalogue the body draws on. */
  features: string[];
  /**
   * Written prose for this topic, where the template would say too little.
   *
   * `composeBody` assembles a post from the feature catalogue, which is the
   * right answer for eight topics that each want the same argument made about a
   * different capability. It is the wrong answer for a topic whose whole value
   * is the specific rule it explains: an article about what an agent may decide
   * that reads like the article about drawing registers is an article nobody
   * quotes and no answer engine has any reason to prefer.
   *
   * Optional, and absent on every topic that does not need it. A free-form
   * topic composed from the console has no definition at all and is unaffected.
   */
  article?: {
    standfirst: string;
    metaDescription: string;
    body: string[];
  };
};

/**
 * The nine things the site should have a page about.
 *
 * One per capability area a buyer searches for, phrased as the phrase they
 * would type, plus the one question that is now asked before any of them —
 * what the software is allowed to decide. Coverage is "a published post carries
 * this keyword", nothing softer: a topic with a draft about it is not covered,
 * because a draft is not on the internet.
 */
export const TOPICS: readonly Topic[] = [
  // First, so it is the next thing the daily release publishes.
  //
  // It is the question every buyer now opens with and the one the site had no
  // page about: the eight topics below each describe a capability, and none of
  // them says what the software is allowed to decide. It is also the only claim
  // here a competitor cannot copy by writing the same sentence — the ceiling is
  // enforced on the write path, not asserted in marketing copy.
  {
    id: 'agents',
    title: 'AI agents in construction: what they may decide',
    keyword: 'AI agents in construction',
    tag: 'AI & Agents',
    features: ['autopilot', 'copilot', 'audit'],
    article: {
      standfirst:
        'Every agent on this platform proposes. A named person disposes. The record says which of the two happened, on every single entry.',
      metaDescription:
        'AI agents in construction can read, check, watch and draft. They may not decide. Where the line sits, why it is enforced, and how to prove it held.',
      body: [
        'AI agents in construction are usually sold as autonomy: the software watches the project and acts on it. ' +
          'That is the wrong shape for this industry, and not because the models are weak. A construction decision ' +
          'has a name against it — an approval, a certificate, an instruction — and the person whose name it is ' +
          'carries the consequence of it for years. Software that decides on their behalf does not remove the ' +
          'consequence. It removes the trail back to whoever was supposed to carry it.',

        '## What can an AI agent actually do on a project?',
        'Everything that is not a decision, which is most of the work. Read the specification and say which clauses ' +
          'have no verification method against them. Watch a programme and name the activities that have quietly lost ' +
          'their float. Read four subcontract returns and say which exclusions make them incomparable. Draft the ' +
          'pay-less notice with the ground and the calculation already set out. Each of those arrives as a proposal, ' +
          'with the records it read attached to it, and then it waits.',
        'The waiting is the point. A proposal sitting in a queue is an hour of work somebody checks in thirty ' +
          'seconds. A proposal that executed itself is a change nobody checked at all — found later, usually by the ' +
          'other side, usually at the worst moment.',

        '## Where is the line between proposing and deciding?',
        'At the event. Every change here is an event on the golden thread, and the catalogue that defines the event ' +
          'types marks which of them software may author and which it may not. A decision — an approval, an award, a ' +
          'certificate, a stage gate — carries a flag that refuses an AI author outright. That is not a setting an ' +
          'administrator can relax on a busy afternoon. It is a property of the event type, checked on the single ' +
          'write path every change in the system goes through.',
        'The agents are bounded from the other end as well. Each holds a mandate, and the ladder stops at propose. ' +
          'No agent holds anything above it, in any capability area, on any subscription tier — so there is no ' +
          'upgrade, no enterprise exception and no flag that turns an agent into an approver. The ceiling is the ' +
          'design rather than a default.',

        '## How do you prove an agent did not decide something?',
        'By replaying the record and reading who authored what. The ledger is append-only and hash-chained: each ' +
          'event carries the hash of the one before it, so an entry cannot be altered or quietly dropped afterwards ' +
          'without breaking every hash that follows it. A replay rebuilds the project from its own history and ' +
          'reports a root hash, and two replays that disagree mean the record was touched.',
        'On top of that, every AI-assisted step names the engine that produced it, the records it read and the ' +
          'person who accepted it. So the question an adjudicator asks — who decided this, and on what — has a ' +
          'literal answer, and that answer separates the draft from the decision. Separating those two is the entire ' +
          'reason the flag on the event type exists.',

        '> An agent that cannot decide is an agent nobody has to defend.',

        '## What do agents cost to run on a project?',
        'Metered, and refused outright when the meter is empty. Each run draws on a wallet the account funds, with ' +
          'pricing per call rather than per seat, and the platform will not call a provider against an empty wallet — ' +
          'it says so, rather than failing quietly and billing for it later. Every charge is written beside the ' +
          'output it paid for, so a month of agent work reads as a list of things produced instead of one line on an ' +
          'invoice.',

        '## Why the line matters more in construction than elsewhere',
        'Because this industry settles its disputes on records, years later, in front of somebody who was not there. ' +
          'It is won by whoever can show what was known and when. Civil infrastructure and water treatment ' +
          'programmes run for years across dozens of firms, and the record has to survive every one of them leaving ' +
          'the job. An agent that had been quietly writing decisions into that record would not be an efficiency. It ' +
          'would be the liability at the centre of the case.',

        '## What you can check without taking our word for it',
        'The demonstration environment runs a seeded programme end to end, with the proposal queue live and every ' +
          'agent’s output attributed to the engine that produced it. Nothing in it is a screenshot.',
        'Any document the platform issues carries a content hash, so a stranger holding one — a solicitor, an ' +
          'insurer, a certifier — can check it against what was issued, with no account and no relationship to ' +
          'anybody involved.',
        'The API is documented for anyone who would rather read the event catalogue than a brochure, and it sets out ' +
          'the eight engines and the stage gates they sit behind.',
        'Platform status is a public page rather than a support ticket, which is the same argument in a smaller frame: ' +
          'a claim anybody can check is worth more than a claim anybody has to accept.',
        'If the design of the ledger interests you more than the pitch does, the engineering notes on this site are ' +
          'where it is written down. If the shape of your own projects is the real question, talk to us and bring ' +
          'one — an agent that may not decide is easiest to judge against work you already know the answer to.',
      ],
    },
  },
  { id: 'commercial', title: 'Cost value reconciliation on a live project', keyword: 'cost value reconciliation', tag: 'Commercial', features: ['commercial', 'payments', 'billing'] },
  { id: 'contracts', title: 'Delay claim assessment with concurrency, not memory', keyword: 'delay claim assessment', tag: 'Contracts', features: ['contracts', 'payments', 'audit'] },
  { id: 'programme', title: 'Critical path float and a real probability of finishing', keyword: 'critical path float', tag: 'Programme', features: ['programme', 'autopilot', 'copilot'] },
  { id: 'risk', title: 'A P80 contingency you can defend in a board paper', keyword: 'P80 contingency', tag: 'Risk & Safety', features: ['risk', 'autopilot', 'audit'] },
  { id: 'field', title: 'Offline site records that survive no signal', keyword: 'offline site records', tag: 'Field', features: ['field', 'audit', 'copilot'] },
  { id: 'design', title: 'A drawing register with supersession and the RFI trail', keyword: 'drawing register', tag: 'Design & BIM', features: ['design', 'audit', 'autopilot'] },
  { id: 'handover', title: 'A handover pack that starts on day one', keyword: 'handover pack', tag: 'Handover', features: ['handover', 'audit', 'enterprise'] },
  { id: 'governance', title: 'The golden thread that detects its own tampering', keyword: 'golden thread', tag: 'Governance', features: ['audit', 'autopilot', 'copilot'] },

  /*
   * Ten more, each written rather than composed.
   *
   * The nine above were the capability map. These are the specific rules this
   * platform enforces that a contractor loses money by not knowing — which is
   * the only kind of post worth writing: an article about the minimum charge
   * that reads like the article about drawing registers is an article nobody
   * quotes and no answer engine has any reason to prefer.
   *
   * Every one of them came out of a real defect or a real refusal in this
   * codebase rather than out of a keyword tool, which is why each can say
   * something specific enough to be worth reading.
   */
  {
    id: 'minimumcharge',
    title: 'Why a unit rate prices a small job too cheap',
    keyword: 'unit rate',
    tag: 'Estimating',
    features: ['commercial', 'audit'],
    article: {
      standfirst:
        'A unit rate is what one more of something costs once you are there. On a small job almost all of the cost is being there at all.',
      metaDescription:
        'A unit rate prices the concrete and not the lorry. Why small quantities need a minimum charge, and what happens to a quotation that leaves it out.',
      body: [
        'A unit rate is the most useful number in estimating and the most dangerous one on a small job. It answers a ' +
          'precise question — what does one more cubic metre cost, once the gang is on site and the machine is ' +
          'working — and it answers nothing at all about the cost of getting there. On a job with four hundred cubic ' +
          'metres of dig that distinction does not matter, because the mobilisation is a rounding error against the ' +
          'measure. On a job with 1.7 cubic metres it is the entire price.',
        '1.7m³ of pad excavation at £90 a cubic metre is £152. Nobody brings a machine and a banksman to a churchyard ' +
          'for £152. 1.35m³ of GEN3 at £280 is £378, and the ready-mix lorry has a minimum load which it charges for ' +
          'whether you take it or not. Price a garden room, a boundary wall or a single pad off unit rates alone and ' +
          'the quotation comes out too cheap to deliver — not because the rates were wrong, but because they were ' +
          'answering a different question.',
        '## What a minimum charge actually covers',
        'The delivery. The minimum load. The half day a two-man gang cannot sell to anybody else. The plant hire that ' +
          'comes in day units whether you need six hours or two. The trip to the tip. The setting out. Every one of ' +
          'those is a real invoice and none of them scales with the measure.',
        'Any estimator who has priced small works knows this and prices it in their head. What they rarely do is ' +
          'write it down in a way that survives being handed to somebody else, or to a spreadsheet, or to software — ' +
          'and that is where it gets lost. A rate library holds rates. It has nowhere to put "and the least this ' +
          'costs at all is four hundred pounds".',
        '## Pricing the line at whichever is greater',
        'CONSTRUX holds both against every measured line: the rate, and the least the item costs to do at all at the ' +
          'quantity measured. The line is priced at whichever is greater, and where the minimum carried it the ' +
          'estimate says so by name rather than folding it silently into a number nobody can reconcile against the ' +
          'rate beside it.',
        'Two rules keep it honest. It never touches a line with no rate against it — a minimum charge there would ' +
          'replace a visible gap with a plausible number, and a plausible number is not questioned. And where it ' +
          'lifts a line, the uplift goes on in the proportions that line is already priced in, so a groundworks ' +
          'minimum stays in groundworks rather than appearing as a site-wide cost nobody can trace.',
        '## Where the number comes from',
        'From the same place as the rate. Where the business has priced the work before, its own committed rates ' +
          'answer both questions. Where it has not, the market view it asks for includes the minimum — and both are ' +
          'labelled as a market view everywhere they appear, kept out of the rate history, and put in front of a ' +
          'person to keep or change before anything is sent to a customer.',
        'It is one field. On a small-works contractor pricing two jobs a week, it is the difference between a ' +
          'quotation that makes money and one that wins. The demonstration project prices a churchyard retaining ' +
          'wall end to end if you want to watch it happen.',
      ],
    },
  },
  {
    id: 'preliminaries',
    title: 'Preliminaries are a weekly cost, not a percentage',
    keyword: 'preliminaries',
    tag: 'Estimating',
    features: ['commercial', 'programme', 'audit'],
    article: {
      standfirst:
        'Price preliminaries as a percentage of the works and a programme that slips eight weeks is eight weeks of cost nobody recovers.',
      metaDescription:
        'Preliminaries are weeks on site multiplied by a weekly rate. Why the percentage method loses money when the programme moves, and what to price instead.',
      body: [
        'Preliminaries are the commonest place an estimate quietly loses money, and the reason is a method rather than ' +
          'a rate. Priced as a percentage of the measured works — eight per cent, twelve, whatever the last job came ' +
          'out at — they become a number that moves when the works move and stays still when the programme does. That ' +
          'is exactly backwards. The welfare unit, the site manager, the safety adviser, the accommodation, the ' +
          'utilities and the gate all cost the same per week whether the works are cheap or dear, and every one of ' +
          'them costs more when the job runs long.',
        'A programme that slips eight weeks on a percentage-priced tender is eight weeks of welfare, supervision and ' +
          'hire that nobody has recovered and nobody can point at. The estimate was never wrong about the total; it ' +
          'was wrong about what the total depended on.',
        '## The right shape',
        'A weekly rate, a duration, and a quantity. Two site managers for twenty weeks is a different number from one ' +
          'for forty, and both are computable from a programme rather than from last year\u2019s percentage. When the ' +
          'duration changes the preliminaries change with it, which is the whole point — a re-priced programme should ' +
          'move the prelims automatically or the estimate is lying about its own sensitivity.',
        'CONSTRUX prices every time-related head this way: preliminaries, site management, logistics, health and ' +
          'safety and quality each take a weekly rate and a number of weeks, and the percentage of works comes out as ' +
          'an output for benchmarking rather than going in as an input. That single reversal is what makes a tender ' +
          'answer the question "what happens if this takes six weeks longer" without anybody rebuilding it. The weekly ' +
          'rates sit in the same cost model as the measured heads, which is set out on how it works.',
        '## The failure it catches',
        'There is a worse version of the same mistake, and it is commoner: excluding the time-related heads ' +
          'altogether. A blank box on a form is easy to leave blank, and an estimating tool that treats blank as ' +
          'excluded will happily produce a four-week job with nothing at all against welfare, supervision or site ' +
          'set-up. Somebody pays for those four weeks, and on a fixed price with them out of the offer that somebody ' +
          'is the contractor.',
        'So a job of two weeks or more that prices not one time-related head is warned about by name. A genuine ' +
          'one-visit job exists and the warning is not a refusal — the estimator is the one who knows which this is. ' +
          'What the platform will not do is let a month of work go out priced as though nobody had to be there. A ' +
          'prolongation argument in adjudication turns on exactly this: what the time-related costs were per week, ' +
          'and whether anybody priced them in the first place.',
      ],
    },
  },
  {
    id: 'paymentnotice',
    title: 'The payment notice that decides who owes what',
    keyword: 'payment notice',
    tag: 'Commercial',
    features: ['commercial', 'contracts', 'audit'],
    article: {
      standfirst:
        'Miss the notice and the notified sum becomes payable in full, whatever the work was worth. It is the cheapest money in construction to lose.',
      metaDescription:
        'A payment notice deadline under the Construction Act is computed from the contract, not remembered. What a missed one costs, and how to stop missing one.',
      body: [
        'The payment notice is the most expensive piece of admin in UK construction. Under the Housing Grants, ' +
          'Construction and Regeneration Act the payer has a fixed window to say what it considers due, and a payer ' +
          'who misses it becomes liable for the notified sum — the figure the other side applied for — regardless of ' +
          'what the work was actually worth. No argument about measurement survives a missed deadline, because the ' +
          'deadline is the argument.',
        'Every contractor in the country either has been caught by this or knows somebody who has. It is not a ' +
          'technical dispute and it is not about quality of work. It is a date, and it was in a diary.',
        '## Why it keeps happening',
        'Because the date is computed rather than given. It depends on the due date, which depends on the ' +
          'application date, which depends on the contract terms — and then the pay-less notice sits a further ' +
          'number of days before the final date for payment, which is itself a count from the due date. Four ' +
          'arithmetic steps, on a different contract for every job, done by somebody with eleven other things on.',
        'A calendar reminder is not a control. It is a copy of the arithmetic, made once, by hand, and never checked ' +
          'against the contract again.',
        '## Computing it once, from the contract',
        'CONSTRUX generates the whole statutory cycle from the contract terms: the due date, the payment notice ' +
          'deadline and the final date for payment, for every period, in one act. Every application submitted ' +
          'inherits the period it falls in, so the notice deadline arrives attached to the application rather than ' +
          'living in somebody\u2019s head. A schedule whose notice deadline fell after its own final date for ' +
          'payment would be refused, because it is a schedule nobody can comply with.',
        '## And the rules on either side of it',
        'Certification is where a valuation becomes a debt, so it is separated from whoever applied — not by role but ' +
          'by person, because a small business stacks roles on one person as a matter of course and separation ' +
          'between job titles is not separation at all. Nothing can be certified above what was applied for. Nothing ' +
          'can be paid above what was certified, in one payment or in two. A certificate cannot be paid twice.',
        'None of that is clever. All of it is the kind of rule that only holds if something other than memory is ' +
          'holding it. What holds it here is a hash-chained record of every application, notice, certificate and ' +
          'payment in the cycle, in the order they happened.',
      ],
    },
  },
  {
    id: 'payless',
    title: 'Writing a pay less notice that survives',
    keyword: 'pay less notice',
    tag: 'Commercial',
    features: ['contracts', 'commercial', 'audit'],
    article: {
      standfirst:
        'A pay less notice reading "defects" is a notice a tribunal disregards. The basis is the notice; the sum is just a number on it.',
      metaDescription:
        'A pay less notice under s.111 needs the sum considered due and the basis on which it was calculated. What "basis" has to mean, and why most notices fail on it.',
      body: [
        'A pay less notice is the payer\u2019s one lawful route to paying less than the notified sum, and section 111 ' +
          'sets two conditions on it: it must be in time, and it must state the sum considered due together with the ' +
          'basis on which that sum was calculated. The first condition is a date and people do generally get it ' +
          'right. The second is a sentence, and it is where notices fail.',
        '"Defects" is not a basis. Neither is "incomplete works", "as discussed" or "see attached". A basis is the ' +
          'calculation: which items, measured at what, against what, and why the difference. A notice that does not ' +
          'contain one is a notice the other side can treat as ineffective, which puts the payer back where they ' +
          'started — liable for the full notified sum.',
        '## What a basis looks like',
        '"Blockwork to grid 4–7 rejected at joint inspection on 24 November and to be rebuilt; £38,000 of the sum ' +
          'applied for is against work that will be taken down." That is arguable. Somebody on the other side can ' +
          'agree with it, dispute the measure, or produce the inspection record. It names the work, the event, the ' +
          'date and the money.',
        'The test is simple and it is worth applying before anything goes out: could the other side answer this? If ' +
          'the only possible response is "answer what?", the notice has not done its job.',
        '## Holding the standard mechanically',
        'CONSTRUX refuses a pay-less notice whose basis is shorter than twenty characters. That is a crude rule and ' +
          'it is deliberately crude — it does not judge the quality of the reasoning, it simply makes the one-word ' +
          'notice impossible to issue by accident at half past five on the deadline. Everything else about the notice ' +
          'is computed: the date it is due by, which period it belongs to, and what the notified sum was.',
        'The notice itself lands on the same record as the application it answers and the certificate beside it, so ' +
          'the sequence is readable a year later without anybody reconstructing it from an inbox. That matters more ' +
          'than it sounds. Most payment disputes are not disagreements about the work. They are disagreements about ' +
          'what was said, when, and whether it arrived in time. Each notice carries a content hash, so the version the ' +
          'other side received is the version that can be checked a year later.',
      ],
    },
  },
  {
    id: 'marketrate',
    title: 'A market rate is not one of your own rates',
    keyword: 'market rate',
    tag: 'Estimating',
    features: ['commercial', 'audit', 'copilot'],
    article: {
      standfirst:
        'A guess that becomes history is a guess that gets more confident every time it is reused. The two have to be told apart, permanently.',
      metaDescription:
        'When a model proposes a market rate it is a starting point, not evidence. Why it must be labelled, ranged, and kept out of your own rate history for ever.',
      body: [
        'A market rate and one of your own rates are different kinds of fact, and an estimating system that stores ' +
          'them in the same place will eventually price a job off the first while believing it is the second. That is ' +
          'not a hypothetical. It is the natural end state of any tool that lets a proposed number become a recorded ' +
          'one without marking the difference.',
        'Your own rate is evidence: it is what this business actually committed on a past estimate, on a job that was ' +
          'won or lost at that number. A market rate is a view — useful, often good, and not a thing anybody stood ' +
          'behind. The moment the second is filed as the first, every later job proposes it as "our rate", and the ' +
          'guess compounds. Three years on nobody remembers it was ever a guess.',
        '## Three rules that keep them apart',
        'First, the record answers before the market does. Where the business has priced something like this before, ' +
          'its own median answers — even a thin one, because what this company charges beats what somebody charges. ' +
          'The market is asked only about the lines nothing in the record can answer, which also keeps the call small ' +
          'and the charge proportionate.',
        'Second, a market view is labelled as one everywhere it appears and carries a range rather than a point. An ' +
          'estimator prices inside a range; a single figure invites a confidence the number does not deserve.',
        'Third, and this is the one that makes the other two safe: a rate a model proposed is kept out of the rate ' +
          'history permanently. A person who keeps it has accepted it and the estimate line records that they did — ' +
          'but it never comes back next year looking like something the business priced. The acceptance is itself an ' +
          'event in the golden thread, so who took the number and when is readable afterwards.',
        '## What the model is actually asked',
        'The measured item, its unit, its quantity and the region, with the answer joined back by the position in the ' +
          'list rather than by the words. That last detail matters more than it should: an earlier version matched ' +
          'the answer to the question on the description text, and a real model paraphrases what it is shown, so ' +
          'every rate it returned was dropped and the screen reported that the market had no view of twenty-two ' +
          'lines it had just taken a view on.',
        'It is also asked what the item costs at all at that quantity — the minimum below which no subcontractor ' +
          'would take the work — because on a small job that is usually the figure that decides the price. A provider ' +
          'that stops answering is reported on platform status rather than quietly producing nothing.',
      ],
    },
  },
  {
    id: 'costheads',
    title: 'The cost heads an estimate quietly omits',
    keyword: 'cost heads',
    tag: 'Estimating',
    features: ['commercial', 'audit'],
    article: {
      standfirst:
        'A tender with nothing against waste is not a tender with no waste in it. The difference is found at final account.',
      metaDescription:
        'Twenty cost heads, each priced on the basis it actually has. Why a head with nothing against it must be reported as unpriced rather than carried as nought.',
      body: [
        'Every estimating package has a list of cost heads and the list is not the interesting part. What loses money ' +
          'is a head with nothing against it, carried as zero, in a tender that adds up perfectly. A tender with ' +
          'nothing against waste is not a tender with no waste in it. It is a tender that will discover the skips at ' +
          'final account, at somebody\u2019s expense, and the somebody is decided by whose name is on the price.',
        'The distinction that matters is between a head that is nought because it was deliberately excluded and a ' +
          'head that is nought because nobody looked at it. Arithmetically they are identical. Commercially they are ' +
          'opposites — one is a qualification the customer can read, the other is a hole.',
        '## Priced, excluded, or an omission',
        'CONSTRUX gives every one of its twenty heads three possible states rather than a number. Priced. Excluded, ' +
          'with the wording that will appear in the tender as a qualification. Or an omission — neither priced nor ' +
          'excluded — and an estimate carrying one is reported as incomplete rather than totalled as though it were ' +
          'finished. A quotation cannot be drawn from an estimate that carries an omission at all.',
        'That refusal is the whole feature. An estimate that adds up is not the same as an estimate that is complete, ' +
          'and every tool that only checks the arithmetic will let the second pass as the first.',
        '## Which heads are even expected',
        'Not all twenty, on every job. A sole trader pricing a £3,000 bathroom has no commissioning, no temporary ' +
          'works design and no site management establishment, and a model that reported fifteen omissions on that job ' +
          'would be ignored inside a week — taking the four that do matter with it. So each head carries the smallest ' +
          'job it is expected on, and the band is taken from what the works are worth.',
        'That banding has a trap in it worth knowing about. Taken from the works as priced, it moves while an ' +
          'estimator is still typing rates in — so a bill that is half rated bands smaller than the job is, names ' +
          'three heads to settle, and then names four different ones the moment the rates arrive. A warning that ' +
          'changes under the person answering it is not a warning, it is a trap, and the band has to come from what ' +
          'the record says the job is worth rather than from a bill still being filled in. The twenty heads, their ' +
          'bases and the three states each one can be in are listed on how it works.',
      ],
    },
  },
  {
    id: 'quotationrows',
    title: 'What a quotation should never show the customer',
    keyword: 'quotation',
    tag: 'Commercial',
    features: ['commercial', 'handover', 'audit'],
    article: {
      standfirst:
        'The customer buys the works at a price. Overhead, profit and cost are how the price was built, and none of the three belongs on the page.',
      metaDescription:
        'A quotation shows the works, the quantities, the money and the qualifications. Why the build-up stays off it, and why the rows must sum to the total exactly.',
      body: [
        'A quotation is an offer to do named work for a stated sum, and almost every way of getting one wrong comes ' +
          'from putting the build-up on it. The customer is buying the works at a price. How that price was arrived ' +
          'at — the labour rate, the overhead recovery, the profit percentage, the cost before margin — is the ' +
          'business\u2019s own commercial position, and a quotation that discloses it has handed the other side the ' +
          'negotiation.',
        'The worst version of this is not a printed margin line. It is an exclusion. A quotation that reads "Not ' +
          'included — Overhead" and "Not included — Profit" tells a client what the business does not intend to ' +
          'charge them. It sounds absurd written down, and it is exactly what a system produces when the estimate\u2019s ' +
          'heads are listed on a form where a blank box means excluded and the margin heads are in the list.',
        '## The four things that do belong',
        'The works, described as they were measured. The quantities. The money. And the qualifications — every head ' +
          'stated as an exclusion, in the wording the estimate recorded, so the customer reads what is not in the ' +
          'offer rather than assuming. Those qualifications are the customer’s copy of what the estimate recorded, and ' +
          'they are the first thing an adjudicator would read.',
        '## And the rows have to add up',
        'A quotation whose lines do not sum to its own total is the first thing a client\u2019s surveyor finds, and it ' +
          'costs more credibility than the error is worth. Where a tender total is apportioned across measured lines, ' +
          'each line\u2019s share should be its share of the cost, using the same arithmetic the estimate used, with ' +
          'the rounding remainder carried onto the last line rather than dropped.',
        'There is a related trap in the presentation. A measured item described properly under NRM2 runs well past ' +
          'eighty characters — "Excavation for two number pad foundations, commencing from existing ground level, ' +
          'maximum depth not exceeding 2.00m" is a hundred and eight — and a document that uses the description as a ' +
          'row label will either refuse it or truncate it. Truncating is the worse of the two: the description is ' +
          'what the customer is being offered, and a quotation that shortens it offers something else, with nothing ' +
          'on the page to say anything was removed. Every issued quotation carries a content hash, so the document a ' +
          'customer holds can be checked against the one that was sent.',
      ],
    },
  },
  {
    id: 'cdp',
    title: 'The Central Digital Platform and your bid readiness',
    keyword: 'Central Digital Platform',
    tag: 'Bidding',
    features: ['contracts', 'audit', 'enterprise'],
    article: {
      standfirst:
        'Since April 2026 a below-threshold award means registering and holding a unique identifier. The underlying problem is older: your own facts live in fifteen places.',
      metaDescription:
        'The Central Digital Platform changed what an SME contractor must hold to bid public work. What it asks for, and why a maintained record beats a folder of PDFs.',
      body: [
        'The Central Digital Platform is the supplier information service behind the Procurement Act 2023, reached ' +
          'through the enhanced Find a Tender service that launched in February 2025. From 1 April 2026 a supplier ' +
          'awarded a notifiable below-threshold contract must be registered on it and hold a unique identifier, which ' +
          'appears in the contract details notice. The thresholds are £12,000 for central government and £30,000 for ' +
          'sub-central, which puts most small works squarely inside it.',
        'Registration itself is not difficult and it is a one-off. What it exposes is the older problem underneath: ' +
          'for most SME contractors, the facts a buyer asks for are not held anywhere in particular. Turnover by ' +
          'year, net assets, insurance limits and expiry dates, accreditations, trades self-delivered, regions ' +
          'worked, the industries actually delivered in, concurrent project capacity — each of them exists, in a folder, in an accountant\u2019s email, on ' +
          'a certificate somebody photographed. They get re-typed into every portal, and they drift.',
        '## Why that costs real work',
        'Because it is re-typed under deadline. A pre-qualification questionnaire filled in at eleven at night from ' +
          'last year\u2019s answers is how a firm declares an insurance limit that expired in March, or a turnover ' +
          'figure that no longer matches the filed accounts. Neither is dishonest. Both are disqualifying.',
        '## A maintained record, not a folder',
        'CONSTRUX holds the company\u2019s own verified facts once, as a record with a version on it, and sets a ' +
          'buyer\u2019s requirements against them rather than against a memory of them. A compliance matrix is ' +
          'produced from a confirmed reading of the invitation, line by line, with the source document and clause ' +
          'against each requirement — so an answer can be traced back to what was actually asked rather than to what ' +
          'somebody thought was asked. The reading, its confirmation and every change to it are events in the golden ' +
          'thread.',
        'And the deliverables register holds what has to go back: every item, whether it is mandatory, its page ' +
          'limit, its format, who owns it and the internal date it is due. A mandatory deliverable with no owner and ' +
          'no internal date is how a correctly priced bid gets disqualified, and it is the most avoidable loss in ' +
          'the industry.',
      ],
    },
  },
  {
    id: 'takeoff',
    title: 'Reading a drawing into an NRM2 take-off',
    keyword: 'NRM2 take-off',
    tag: 'Estimating',
    features: ['design', 'commercial', 'copilot'],
    article: {
      standfirst:
        'A machine can measure what is dimensioned on a sheet. What it must not do is turn a reading into a bill without a person confirming it.',
      metaDescription:
        'An NRM2 take-off read off a drawing by a model, confirmed by a surveyor, and traced to the sheet and revision it came from. Where the line sits and why.',
      body: [
        'An NRM2 take-off is a measurement discipline before it is a document: rules about what is measured, in what ' +
          'unit, and what is deemed included. A machine reading a drawing can do the arithmetic part of that well — ' +
          'finding the dimensioned quantities on a sheet and reporting them against the rule applied. What it cannot ' +
          'do is carry the responsibility for the answer, and that distinction decides how the whole thing should be ' +
          'built.',
        'So the reading arrives as a draft. Every item carries the sheet it was measured from, the rule applied and ' +
          'how confident the reading was, and nothing becomes a bill item until a surveyor confirms it. The ' +
          'confirmation is not an apology for the automation. It is the reason the resulting number is defensible ' +
          'two years later, when somebody asks where it came from. The sheet, the rule and the specification the rule ' +
          'came from are named alongside the confirmation.',
        '## What the reading is allowed to leave out',
        'Anything that would require an assumption. A reading that reports only what is dimensioned or scalable on ' +
          'the sheet, and says separately what it omitted and why, is far more useful than one that fills every row. ' +
          'An omitted line is corrected in seconds. A confident wrong quantity is not noticed until the job is built ' +
          'at a loss.',
        'The same applies to whole sheets. A pack of five where one could not be read and the screen shows four is a ' +
          'pack silently mispriced, so an unreadable drawing is named rather than skipped.',
        '## Traceable to the sheet and the revision',
        'Every measured item keeps the drawing and revision it came off. That is what makes a re-issue manageable: ' +
          'when a sheet goes to P03 the measure taken against P02 no longer describes the job, and the items it ' +
          'produced can be retired — recorded as superseded with a reason, never deleted, because a quantity ' +
          'somebody priced against is a fact about what was believed at the time.',
        'A bill that quietly loses lines is a bill whose history cannot be read, which is the opposite of what a ' +
          'measurement record is for. A superseded item keeps its content hash, so a price given against P02 can still ' +
          'be checked against the sheet it was measured from.',
      ],
    },
  },
  {
    id: 'separation',
    title: 'Separation of duties on a payment certificate',
    keyword: 'separation of duties',
    tag: 'Governance',
    features: ['commercial', 'audit', 'enterprise'],
    article: {
      standfirst:
        'Separation between roles is not separation between people. A small business stacks roles on one person as a matter of course.',
      metaDescription:
        'The person who applied for a payment should not certify it. Why a permission matrix does not achieve that, and what a sole trader does instead.',
      body: [
        'Separation of duties is the oldest control in commercial administration and the easiest to implement wrongly ' +
          'in software. The usual approach is a permission matrix: one role may submit an application, another may ' +
          'certify it, and the system enforces the boundary between them. That is separation between roles, and it is ' +
          'not the same thing as separation between people.',
        'A small contractor stacks roles on one person as a matter of course — the same individual is the quantity ' +
          'surveyor and the commercial director, because there are eleven people in the business. Give that ' +
          'identity both roles and the matrix is satisfied while the control has evaporated: one person can apply ' +
          'for a payment and turn it into a debt with nobody else in the loop. Certification is the moment a ' +
          'valuation becomes money owed, and it is precisely the moment a second pair of eyes is worth having.',
        '## Enforced against the person, not the title',
        'CONSTRUX records who submitted an application and refuses to let that identity certify it, whatever roles ' +
          'they hold. The same rule applies to a quotation: the person who priced the job does not approve the ' +
          'document that goes to the customer. It is a hard refusal rather than an override with a note, because an ' +
          'override is taken every time by exactly the person the control exists to stop. The rule lives in the ' +
          'permission model rather than in a screen, so it holds on the api exactly as it holds in the console.',
        '## And the sole trader',
        'There is one exception and it is not a softening. On a business where no other active identity holds ' +
          'payment authority, the remedy the refusal names — assign it to somebody else — names nobody. A sole ' +
          'trader was not being held to the control, they were stopped by it permanently, and could not certify a ' +
          'payment on their own business at all.',
        'So the act proceeds, and the certificate carries in its own words that one person did both and that nobody ' +
          'else could have. That is a truthful record of a real constraint, which is worth considerably more than ' +
          'either pretending the control held or refusing to let a one-person business invoice. It is also the kind of ' +
          'record an adjudicator can read, which is the only test that finally matters.',
      ],
    },
  },
];

/**
 * The catalogue as it stands: the nine in the source, plus every topic a person
 * has added since.
 *
 * The nine above are the seed and are not touched. What they were not is a
 * supply: the daily release published one a day until the ninth, and then
 * published nothing, for ever, with the only record of it a note on a release
 * nobody reads. The site stopped on 6 September 2026 and nothing anywhere said
 * why — the same silent nought that has cost this project a week, in a
 * different corner of it.
 *
 * Added topics come after the seeded ones, in the order they were recorded, so
 * the release keeps its documented behaviour of taking the first uncovered
 * topic in the list.
 */
export function allTopics(platform: Platform): Topic[] {
  const added = platform.ledger
    .list(BLOG_PROJECT_ID, 'MarketingTopic')
    .map((record) => record.state as unknown as Topic)
    .sort((a, b) => String((a as Topic & { addedAt?: string }).addedAt ?? '').localeCompare(String((b as Topic & { addedAt?: string }).addedAt ?? '')));
  // A recorded topic whose keyword matches a seeded one would have the release
  // skip it for ever, because coverage is keyed on the keyword. Dropped here
  // rather than at the point of writing, so a seed added later cannot silently
  // orphan a topic somebody recorded before it existed.
  const seeded = new Set(TOPICS.map((topic) => topic.keyword.trim().toLowerCase()));
  return [...TOPICS, ...added.filter((topic) => !seeded.has(topic.keyword.trim().toLowerCase()))];
}

/** Record a subject for the blog to write about. */
export function addTopic(
  platform: Platform,
  actor: PostActor,
  input: { title: string; keyword: string; tag: string },
): { topic: Topic } {
  const title = input.title.trim();
  const keyword = input.keyword.trim();
  const tag = input.tag.trim();

  // The same gates `composePost` applies, applied at the point the topic is
  // recorded rather than the day the release tries to use it. A topic that
  // cannot produce a publishable post is a day the blog does not publish, and
  // the person who would have to fix it is not at the keyboard at 06:00.
  if (title.length < 10 || title.length > 80) {
    throw new DomainError('TITLE_LENGTH', 'A title is between ten and eighty characters — the page title check refuses anything longer.', 422);
  }
  if (keyword.length < 3 || keyword.length > 40) {
    throw new DomainError('KEYWORD_LENGTH', 'The phrase this post is meant to be found by is between three and forty characters.', 422);
  }
  if (!title.toLowerCase().includes(keyword.toLowerCase())) {
    throw new DomainError(
      'KEYWORD_NOT_IN_TITLE',
      `The title has to contain "${keyword}". A post whose title does not carry its own keyword is held by its own checks on the morning it is written, and nobody is watching at six o'clock.`,
      422,
    );
  }
  if (tag.length < 2 || tag.length > 40) throw new DomainError('TAG_REQUIRED', 'File it under something, in two to forty characters.', 422);

  const existing = allTopics(platform).find((topic) => topic.keyword.trim().toLowerCase() === keyword.toLowerCase());
  if (existing) {
    throw new DomainError(
      'TOPIC_ALREADY_RECORDED',
      `"${existing.title}" is already in the library under that phrase. Two topics on one keyword compete with each other for the same search.`,
      409,
    );
  }

  const topic: Topic & { addedAt: string; addedBy: string } = {
    id: `topic-${ulid()}`,
    title,
    keyword,
    tag,
    // Composed from the feature catalogue, like the seeded topics that carry no
    // written article. A person who wants specific prose writes the post itself
    // from the compose form; this is the supply for the daily release.
    features: [],
    addedAt: new Date().toISOString(),
    addedBy: actor.refId,
  };

  platform.ledger.commit({
    tenantId: PLATFORM_TENANT_ID,
    projectId: BLOG_PROJECT_ID,
    actor,
    source: 'WEB',
    correlationId: topic.id,
    eventType: 'MARKETING_TOPIC_ADDED',
    entity: { refType: 'MarketingTopic', refId: topic.id },
    nextState: topic as unknown as Record<string, unknown>,
  });

  return { topic };
}

/** The post that covers a topic, if one is on the record. Published first. */
function postForTopic(platform: Platform, topic: Topic): BlogPost | undefined {
  const matching = posts(platform).filter((post) => post.keyword.trim().toLowerCase() === topic.keyword.toLowerCase());
  return matching.find((post) => post.status === 'PUBLISHED') ?? matching.find((post) => post.status === 'DRAFT') ?? matching[0];
}

export function topicCoverage(platform: Platform): Array<Topic & { covered: boolean; post?: { id: string; slug: string; status: BlogPost['status'] } }> {
  return allTopics(platform).map((topic) => {
    const post = postForTopic(platform, topic);
    return {
      ...topic,
      covered: post?.status === 'PUBLISHED',
      ...(post ? { post: { id: post.id, slug: post.slug, status: post.status } } : {}),
    };
  });
}

// --- The composer -------------------------------------------------------------

export type ComposeInput = {
  /** What the post is about, in a phrase. Becomes the title where it fits. */
  topic: string;
  /** The phrases it should be found by. The first is the one the checks enforce. */
  keywords: string[];
  tag?: string;
  /** Publish on the spot where every check passes. Default true. */
  publish?: boolean;
};

export type ComposeResult = {
  post: BlogPost;
  seo: ReturnType<typeof seoReport>;
  /** What actually happened, because "generate & publish" can legitimately stop at "generate". */
  outcome: 'PUBLISHED' | 'DRAFT' | 'HELD_BY_CHECKS';
  /** The checks that held it, when they did. */
  held: string[];
  /** Which pages the body links into, read from the same linker the page uses. */
  linked: Array<{ term: string; path: string }>;
};

function capitalise(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

/**
 * A title that fits a search result and carries the keyword.
 *
 * Tried in order of how natural each reads; the first that fits wins. None
 * fitting is refused with the reason rather than published truncated — a title
 * cut mid-word is exactly what the title check exists to stop.
 */
function fitTitle(topic: string, keyword: string): string {
  const candidates = [
    topic,
    `${topic}: ${keyword}`,
    `${capitalise(keyword)}: ${topic}`,
    `${capitalise(keyword)} on a governed construction record`,
    `${capitalise(keyword)}: what the record has to show`,
  ];
  const lower = keyword.toLowerCase();
  const fit = candidates.find(
    (candidate) => candidate.length >= SEO.titleMin && candidate.length <= SEO.titleMax && candidate.toLowerCase().includes(lower),
  );
  if (!fit) {
    throw new DomainError(
      'TITLE_UNFITTABLE',
      `No title between ${SEO.titleMin} and ${SEO.titleMax} characters can be made from "${topic}" that carries "${keyword}". ` +
        'Shorten the topic or the keyword.',
      422,
    );
  }
  return fit;
}

/** The catalogue entries a free-form topic is about, by the words it shares with them. */
function featuresFor(topic: string, keywords: string[], preferred: string[] = []): Feature[] {
  const byId = new Map(FEATURES.map((feature) => [feature.id, feature] as const));
  const chosen: Feature[] = preferred.map((id) => byId.get(id)).filter((feature): feature is Feature => feature !== undefined);
  if (chosen.length >= 3) return chosen.slice(0, 3);

  const words = `${topic} ${keywords.join(' ')}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3);
  const scored = FEATURES.filter((feature) => !chosen.includes(feature))
    .map((feature) => {
      const haystack = `${feature.title} ${feature.blurb}`.toLowerCase();
      return { feature, score: words.filter((word) => haystack.includes(word)).length };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  for (const entry of scored) {
    if (chosen.length >= 3) break;
    chosen.push(entry.feature);
  }
  // The three every post can truthfully say, when nothing more specific matched.
  for (const id of ['audit', 'autopilot', 'copilot']) {
    if (chosen.length >= 3) break;
    const feature = byId.get(id);
    if (feature && !chosen.includes(feature)) chosen.push(feature);
  }
  return chosen;
}

/**
 * The body, from the catalogue.
 *
 * The opening carries the keyword, as the gate requires; the middle is the
 * catalogue's own sentences under the feature's own title; the close names the
 * three things a reader can check without taking anybody's word — replay, the
 * document hash, the provenance on AI output — and points at the demonstration.
 * Phrases the glossary knows ("golden thread", "demo environment", "verify a
 * document") are in the fixed prose on purpose, so every composed post links
 * into the site at least twice.
 */
function composeBody(keyword: string, features: Feature[]): string[] {
  const lead = capitalise(keyword);
  return [
    `${lead} is the kind of thing a construction project usually argues about after the fact, from memory, with the ` +
      'evidence spread across inboxes and spreadsheets. CONSTRUX treats it as a record: every change to it is an ' +
      'append-only, hash-chained event on the golden thread, written before it is acknowledged, so the question ' +
      '"what did we know, and when" has an answer rather than an opinion.',
    '## Where it goes wrong',
    'The failure is rarely a missing number. It is a number that exists in three places and agrees in none of them — ' +
      `the site diary, the commercial report and the board paper each telling a slightly different story about ${keyword}, ` +
      'with nobody able to say which was true on the day it mattered. By the time the disagreement surfaces it is a ' +
      'dispute rather than a decision, and a dispute is priced by whoever kept the better record.',
    '## How CONSTRUX handles it',
    ...features.map((feature) => `${feature.title}. ${feature.blurb}`),
    '> A record you can replay is a record you can rely on.',
    '## What you can check for yourself',
    'None of this asks for trust. Replay reconstructs a project from its own history and reports a root hash; a ' +
      'document issued from the platform carries a content hash that lets anybody verify a document against what was ' +
      'issued; and every AI-assisted step names the engine that produced it and the records it read. If ' +
      `${keyword} matters on your projects, the demo environment runs the whole cycle on a seeded programme — open it, ` +
      'run it, and read the record it leaves behind.',
  ];
}

/**
 * Write a post from the catalogue, and publish it where every check passes.
 *
 * `publish` defaults to true because that is what the button says, and the
 * result says what happened: PUBLISHED, DRAFT (asked not to), or HELD_BY_CHECKS
 * with the checks named — never a success that did not occur.
 */
export function composePost(platform: Platform, actor: PostActor, input: ComposeInput, topicDefinition?: Topic): ComposeResult {
  const topic = input.topic.trim();
  const keywords = input.keywords.map((keyword) => keyword.trim()).filter(Boolean);
  if (topic.length < 3 || topic.length > 80) throw new DomainError('TOPIC_REQUIRED', 'Say what the post is about, in three to eighty characters.', 422);
  if (keywords.length === 0) throw new DomainError('KEYWORD_REQUIRED', 'A post needs at least one phrase it is meant to be found by.', 422);
  if (keywords.length > 5) throw new DomainError('TOO_MANY_KEYWORDS', 'Five keywords at most. A post found by everything is found by nothing.', 422);
  for (const keyword of keywords) {
    if (keyword.length < 3 || keyword.length > 40) {
      throw new DomainError('KEYWORD_LENGTH', `"${keyword}" — a keyword is between three and forty characters.`, 422);
    }
  }

  const keyword = keywords[0]!;
  const title = fitTitle(topic, keyword);
  const slug = uniqueSlug(platform, title);
  if (slug.length === 0) throw new DomainError('TITLE_REQUIRED', 'That title produces no usable address.', 422);

  // A topic that carries written prose uses it; everything else is assembled
  // from the catalogue as before. The gate is the same either way — a written
  // article that failed a check would be held exactly like a composed one.
  const written = topicDefinition?.article;
  const body = written?.body ?? composeBody(keyword, featuresFor(topic, keywords, topicDefinition?.features));

  const post: BlogPost = {
    id: ulid(),
    slug,
    title,
    standfirst:
      written?.standfirst ?? `What ${keyword} looks like on a governed record, and the checks a reader can run for themselves.`,
    metaDescription:
      written?.metaDescription ??
      `${capitalise(keyword)}: how CONSTRUX records it as governed, evidenced events on the golden thread, and what a ` +
        'reader can verify for themselves.',
    body,
    tag: input.tag?.trim() || topicDefinition?.tag || 'Marketing',
    keyword,
    status: 'DRAFT',
    authorship: 'MARKETING_AGENT',
    draftedAt: new Date().toISOString(),
    draftedBy: actor.refId,
  };

  commitPost(platform, actor, { eventType: 'SITE_POST_DRAFTED', post });

  const seo = seoReport(post);
  const held = seo.filter((finding) => !finding.ok).map((finding) => `${finding.check}: ${finding.detail}`);
  const { linked } = hyperlink(body.map((line) => esc(line)), { exclude: `/blog/${slug}` });

  if (input.publish === false) return { post, seo, outcome: 'DRAFT', held, linked };
  if (held.length > 0) return { post, seo, outcome: 'HELD_BY_CHECKS', held, linked };

  const published = publishAs(platform, actor, post.id);
  return { post: published.post, seo: published.seo, outcome: 'PUBLISHED', held: [], linked };
}

/**
 * One post per topic that has none.
 *
 * Idempotent by keyword: a topic with a post already on the record — published
 * or still a draft — is skipped and said so, so pressing the button twice
 * writes nothing twice.
 */
export function generateLibrary(
  platform: Platform,
  actor: PostActor,
): { created: ComposeResult[]; skipped: Array<{ topic: string; because: string }> } {
  const created: ComposeResult[] = [];
  const skipped: Array<{ topic: string; because: string }> = [];
  for (const topic of allTopics(platform)) {
    const existing = postForTopic(platform, topic);
    if (existing) {
      skipped.push({ topic: topic.id, because: `Already on the record as /blog/${existing.slug} (${existing.status.toLowerCase()}).` });
      continue;
    }
    created.push(composePost(platform, actor, { topic: topic.title, keywords: [topic.keyword], tag: topic.tag }, topic));
  }
  return { created, skipped };
}

// --- Share kit ----------------------------------------------------------------

export type ShareKitEntry = {
  channel: string;
  label: string;
  /** The network's composer with the address in it, or the address itself for copy. */
  url: string;
  /** Suggested copy, within the network's limit where it has one. */
  text: string;
};

/** What to paste where, per channel, for one post. Deterministic, from the record. */
export function shareKit(post: Pick<BlogPost, 'slug' | 'title' | 'standfirst'>): ShareKitEntry[] {
  const url = postUrl(post.slug);
  const targets = shareTargets({ url, title: post.title });
  const long = `${post.title}\n\n${post.standfirst}\n\n${url}`;
  // X counts a link as 23 characters whatever its length; the rest is text.
  const room = 280 - 23 - 1;
  const short = post.title.length <= room ? `${post.title} ${url}` : `${post.title.slice(0, room - 1)}… ${url}`;
  return SHARE_CHANNELS.map((channel) => ({
    channel: channel.id,
    label: channel.label,
    url: channel.id === 'copy' ? url : targets[channel.id],
    text: channel.id === 'x' ? short : channel.id === 'email' ? `${post.title}\n\n${post.standfirst}\n\nRead it: ${url}` : long,
  }));
}

// --- Distribution -------------------------------------------------------------

export type DistributionChannel = 'linkedin' | 'x' | 'email';

export type ChannelStatus = {
  id: DistributionChannel;
  label: string;
  configured: boolean;
  /** The environment variables that are unset, so the screen can say which. */
  missing: string[];
  /** Where a send goes, in words. */
  target: string;
};

export function distributionChannels(): ChannelStatus[] {
  const m = config.marketing;
  const linkedinMissing = [m.linkedinAccessToken === '' ? 'LINKEDIN_ACCESS_TOKEN' : '', m.linkedinOrgId === '' ? 'LINKEDIN_ORG_ID' : ''].filter(Boolean);
  const xMissing = [m.xAccessToken === '' ? 'X_ACCESS_TOKEN' : ''].filter(Boolean);
  const emailMissing = [config.smtp.host === '' ? 'SMTP_HOST' : '', m.announceTo === '' ? 'MARKETING_ANNOUNCE_TO' : ''].filter(Boolean);
  return [
    {
      id: 'linkedin',
      label: 'LinkedIn',
      configured: linkedinMissing.length === 0,
      missing: linkedinMissing,
      target: m.linkedinOrgId ? `organisation ${m.linkedinOrgId}` : 'the organisation page named by LINKEDIN_ORG_ID',
    },
    { id: 'x', label: 'X', configured: xMissing.length === 0, missing: xMissing, target: 'the account the token belongs to' },
    {
      id: 'email',
      label: 'Email',
      configured: emailMissing.length === 0,
      missing: emailMissing,
      target: m.announceTo || 'the address named by MARKETING_ANNOUNCE_TO',
    },
  ];
}

export type Distribution = {
  id: string;
  postId: string;
  slug: string;
  channel: DistributionChannel;
  status: 'SENT' | 'FAILED';
  /** The network's identifier for what it created, where it gave one. */
  remoteId?: string;
  /** The network's answer, in its words. */
  detail: string;
  at: string;
  by: PostActor;
};

/**
 * Where each channel is reached. Held in one place, and replaceable, so the
 * client is tested against a socket that answers like the network rather than
 * against a mock of itself.
 */
const targets: { linkedin: string; x: string; smtp?: SmtpOptions } = {
  linkedin: 'https://api.linkedin.com/rest/posts',
  x: 'https://api.x.com/2/tweets',
};

/** Test isolation only. */
export function setDistributionTargets(overrides: Partial<typeof targets>): void {
  Object.assign(targets, overrides);
}

/** How long a network gets to answer before the send is recorded as failed. */
const SEND_TIMEOUT_MS = 15_000;

export function distributionsFor(platform: Platform, postId?: string): Distribution[] {
  return platform.ledger
    .list(BLOG_PROJECT_ID, 'SitePostDistribution')
    .map((row) => row.state as unknown as Distribution)
    .filter((entry) => postId === undefined || entry.postId === postId)
    .sort((a, b) => a.at.localeCompare(b.at));
}

async function readAnswer(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '';
  }
}

async function sendLinkedIn(post: BlogPost): Promise<{ remoteId?: string; detail: string }> {
  const kit = shareKit(post).find((entry) => entry.channel === 'linkedin')!;
  const response = await fetch(targets.linkedin, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.marketing.linkedinAccessToken}`,
      'content-type': 'application/json',
      'linkedin-version': '202409',
      'x-restli-protocol-version': '2.0.0',
    },
    body: JSON.stringify({
      author: `urn:li:organization:${config.marketing.linkedinOrgId}`,
      commentary: kit.text,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { article: { source: postUrl(post.slug), title: post.title, description: post.standfirst } },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`LinkedIn answered ${response.status}: ${await readAnswer(response)}`);
  const remoteId = response.headers.get('x-restli-id') ?? undefined;
  return { remoteId, detail: `LinkedIn accepted the post (${response.status})${remoteId ? ` as ${remoteId}` : ''}.` };
}

async function sendX(post: BlogPost): Promise<{ remoteId?: string; detail: string }> {
  const kit = shareKit(post).find((entry) => entry.channel === 'x')!;
  const response = await fetch(targets.x, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.marketing.xAccessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: kit.text }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`X answered ${response.status}: ${await readAnswer(response)}`);
  let remoteId: string | undefined;
  try {
    const parsed = JSON.parse(await response.text()) as { data?: { id?: unknown } };
    if (typeof parsed.data?.id === 'string') remoteId = parsed.data.id;
  } catch {
    // An answer that is not JSON is still a 2xx: the post went. The id is a courtesy.
  }
  return { remoteId, detail: `X accepted the post (${response.status})${remoteId ? ` as ${remoteId}` : ''}.` };
}

/** RFC 2047, so a title with a dash or an accent survives the Subject line. */
function encodedWord(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?utf-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

async function sendEmail(post: BlogPost): Promise<{ remoteId?: string; detail: string }> {
  const kit = shareKit(post).find((entry) => entry.channel === 'email')!;
  const body = Buffer.from(kit.text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const raw = [
    `From: ${encodedWord(config.newsletter.fromName)} <${config.newsletter.fromAddress}>`,
    `To: <${config.marketing.announceTo}>`,
    `Subject: ${encodedWord(`New on the CONSTRUX blog: ${post.title}`)}`,
    `Message-ID: <${post.id}.announce@construxvg.com>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
    '',
  ].join('\r\n');
  const result = await sendMail(
    { from: config.newsletter.fromAddress, to: config.marketing.announceTo, raw },
    targets.smtp ?? { ...config.smtp },
  );
  if (!result.accepted) throw new Error(`The relay refused it: ${result.response}`);
  return { detail: `Sent to ${config.marketing.announceTo}; relay answered ${result.response.trim()}.` };
}

/**
 * Send one published post to the configured channels.
 *
 * Per channel: unconfigured is skipped and named; already sent is skipped and
 * named; otherwise one attempt, and the outcome — sent with the network's id,
 * or failed with the network's words — goes on the record either way. A draft
 * is refused: there is no public address to send.
 */
export async function distributePost(
  platform: Platform,
  actor: PostActor,
  postId: string,
  channels?: DistributionChannel[],
): Promise<{ post: BlogPost; sent: Distribution[]; failed: Distribution[]; skipped: Array<{ channel: DistributionChannel; because: string }> }> {
  const post = posts(platform).find((candidate) => candidate.id === postId);
  if (!post) throw new DomainError('POST_NOT_FOUND', `No post ${postId}`, 404);
  if (post.status !== 'PUBLISHED') {
    throw new DomainError('NOT_PUBLISHED', 'Only a live post can be sent anywhere — a draft has no public address.', 409);
  }

  const wanted = new Set<DistributionChannel>(channels && channels.length > 0 ? channels : ['linkedin', 'x', 'email']);
  const already = distributionsFor(platform, post.id).filter((entry) => entry.status === 'SENT');
  const sent: Distribution[] = [];
  const failed: Distribution[] = [];
  const skipped: Array<{ channel: DistributionChannel; because: string }> = [];

  for (const status of distributionChannels()) {
    if (!wanted.has(status.id)) continue;
    if (!status.configured) {
      skipped.push({ channel: status.id, because: `Not configured: ${status.missing.join(', ')} unset.` });
      continue;
    }
    const before = already.find((entry) => entry.channel === status.id);
    if (before) {
      skipped.push({ channel: status.id, because: `Already sent ${before.at}${before.remoteId ? ` as ${before.remoteId}` : ''}.` });
      continue;
    }

    let outcome: Distribution;
    try {
      const answer = status.id === 'linkedin' ? await sendLinkedIn(post) : status.id === 'x' ? await sendX(post) : await sendEmail(post);
      outcome = { id: ulid(), postId: post.id, slug: post.slug, channel: status.id, status: 'SENT', ...answer, at: new Date().toISOString(), by: actor };
    } catch (error) {
      outcome = {
        id: ulid(),
        postId: post.id,
        slug: post.slug,
        channel: status.id,
        status: 'FAILED',
        detail: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
        by: actor,
      };
    }

    platform.ledger.commit({
      tenantId: PLATFORM_TENANT_ID,
      projectId: BLOG_PROJECT_ID,
      actor,
      source: 'SYSTEM',
      correlationId: post.id,
      eventType: 'SITE_POST_DISTRIBUTED',
      entity: { refType: 'SitePostDistribution', refId: outcome.id },
      nextState: outcome as unknown as Record<string, unknown>,
    });
    (outcome.status === 'SENT' ? sent : failed).push(outcome);
  }

  return { post, sent, failed, skipped };
}

// --- The daily release --------------------------------------------------------

export type MarketingRelease = {
  id: string;
  /** UTC date, `YYYY-MM-DD`. The idempotency key. */
  day: string;
  ranAt: string;
  trigger: 'SCHEDULER' | 'OPERATOR';
  by: PostActor;
  /** What went live, or null with the reason in `note`. */
  published: { postId: string; slug: string; title: string; topic: string } | null;
  sent: Distribution[];
  failed: Distribution[];
  skipped: Array<{ channel: DistributionChannel; because: string }>;
  note: string;
};

export function releaseDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function releases(platform: Platform): MarketingRelease[] {
  return platform.ledger
    .list(BLOG_PROJECT_ID, 'MarketingRelease')
    .map((row) => row.state as unknown as MarketingRelease)
    .sort((a, b) => b.day.localeCompare(a.day));
}

export function releaseFor(platform: Platform, day: string): MarketingRelease | undefined {
  return releases(platform).find((release) => release.day === day);
}

/**
 * Today's release: publish the next uncovered topic, send it where a channel
 * is configured, and write down what happened — once.
 *
 * With every topic covered it publishes nothing and says so. It does not
 * re-share an old post to fill the day: a channel that sees the same article
 * every morning is a channel that stops seeing the company.
 */
export async function runDailyRelease(
  platform: Platform,
  actor: PostActor,
  options: { trigger: MarketingRelease['trigger']; now?: Date } ,
): Promise<MarketingRelease & { alreadyRun: boolean }> {
  const day = releaseDay(options.now);
  const existing = releaseFor(platform, day);
  if (existing) return { ...existing, alreadyRun: true };

  const library = allTopics(platform);
  const next = library.find((topic) => postForTopic(platform, topic) === undefined);
  let published: MarketingRelease['published'] = null;
  let note: string;
  let sent: Distribution[] = [];
  let failed: Distribution[] = [];
  let skipped: MarketingRelease['skipped'] = [];

  if (!next) {
    /*
     * The library is empty, and this is the sentence that has to make somebody
     * act.
     *
     * The old wording — "every topic in the library is on the record; nothing
     * new was published today" — is true and reads like a clean run. It was
     * written on the day the ninth topic was published and then repeated,
     * unread, every morning for a fortnight while the site went stale. A note
     * that describes a stopped blog in the tone of a successful one is worse
     * than no note.
     */
    note =
      `The library is empty: all ${library.length} topic${library.length === 1 ? '' : 's'} already have a post, so nothing ` +
      'was published today and nothing will be published tomorrow either. ' +
      'ADD A TOPIC on Growth — the release has nothing to write about until somebody does.';
  } else {
    const composed = composePost(platform, actor, { topic: next.title, keywords: [next.keyword], tag: next.tag }, next);
    if (composed.outcome !== 'PUBLISHED') {
      note = `Composed /blog/${composed.post.slug} for "${next.id}" but it is held by its checks: ${composed.held.join(' ')}`;
    } else {
      published = { postId: composed.post.id, slug: composed.post.slug, title: composed.post.title, topic: next.id };
      const outcome = await distributePost(platform, actor, composed.post.id);
      sent = outcome.sent;
      failed = outcome.failed;
      skipped = outcome.skipped;
      note =
        `Published /blog/${composed.post.slug}. ` +
        (sent.length > 0 ? `Sent to ${sent.map((entry) => entry.channel).join(', ')}. ` : '') +
        (failed.length > 0 ? `Refused by ${failed.map((entry) => entry.channel).join(', ')}. ` : '') +
        (skipped.length > 0 ? `Not sent to ${skipped.map((entry) => entry.channel).join(', ')}: ${skipped.map((entry) => entry.because).join(' ')}` : '');
    }
  }

  const release: MarketingRelease = {
    id: `release-${day}`,
    day,
    ranAt: new Date().toISOString(),
    trigger: options.trigger,
    by: actor,
    published,
    sent,
    failed,
    skipped,
    note: note.trim(),
  };

  platform.ledger.commit({
    tenantId: PLATFORM_TENANT_ID,
    projectId: BLOG_PROJECT_ID,
    actor,
    source: 'SYSTEM',
    correlationId: release.id,
    eventType: 'MARKETING_RELEASE_RUN',
    entity: { refType: 'MarketingRelease', refId: release.id },
    nextState: release as unknown as Record<string, unknown>,
  });

  return { ...release, alreadyRun: false };
}

/** The actor the timer acts as. Named, so a scheduled post is not attributed to whoever last signed in. */
export const SCHEDULER: PostActor = { refType: 'System', refId: 'marketing-scheduler' };

/** Milliseconds between wake-ups. Hourly, like the newsletter's: date-keyed idempotency makes polling safe. */
const TICK_MS = 3_600_000;

/**
 * The daily timer. Off unless `MARKETING_RELEASE_ENABLED`; asks the record
 * before acting, so a restart inside the release hour cannot publish twice.
 */
export function startMarketingSchedule(
  platform: Platform,
  onRelease: (release: MarketingRelease) => void = () => {},
): { stop: () => void } {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running || !config.marketing.releaseEnabled) return;
    const now = new Date();
    if (now.getUTCHours() !== config.marketing.releaseHourUtc) return;
    // Which days are eligible. Empty means every day, as it always did.
    const days = config.marketing.releaseDaysUtc;
    if (days.length > 0 && !days.includes(now.getUTCDay() === 0 ? 7 : now.getUTCDay())) return;
    if (releaseFor(platform, releaseDay(now))) return;

    running = true;
    try {
      onRelease(await runDailyRelease(platform, SCHEDULER, { trigger: 'SCHEDULER', now }));
    } catch (error) {
      process.stderr.write(`[marketing] release failed: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  void tick();
  return { stop: () => clearInterval(timer) };
}

// --- The sweep ----------------------------------------------------------------

export type SweepFinding = {
  check: string;
  ok: boolean;
  /** Out of the hundred the signal score is made of. */
  weight: number;
  detail: string;
};

/** How stale the newest page may be before the site reads as abandoned. */
export const FRESHNESS_DAYS = 14;
/** Contextual links into the site a post should carry to hold a reader. */
export const MIN_INTERNAL_LINKS = 2;

const FRONTEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'frontend');

function headOf(html: string): { title: string; description: string } {
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
  const description = /<meta name="description" content="([^"]*)">/.exec(html)?.[1] ?? '';
  return { title, description };
}

function jsonLdBlocks(html: string): string[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
}

/** Every published post, compiled and stored, as the sweep reads them. */
function livePosts(platform: Platform): Array<{ slug: string; title: string; date: string; keyword?: string; body: string[]; stored: boolean }> {
  return [
    ...POSTS.map((post) => ({ slug: post.slug, title: post.title, date: post.date, body: post.body, stored: false })),
    ...publishedPosts(platform).map((post) => ({
      slug: post.slug,
      title: post.title,
      date: (post.publishedAt ?? '').slice(0, 10),
      keyword: post.keyword,
      body: post.body.map((line) => esc(line)),
      stored: true,
    })),
  ];
}

/**
 * Twelve checks against the site as it is served.
 *
 * Each is what an outside reader — a crawler, a link preview, a search result
 * — would find, read off the rendered page rather than a setting. The weights
 * say what costs traffic: a stale site and an uncovered topic cost more than a
 * missing hreflang on a single-language site.
 */
export function seoSweep(platform: Platform, now: Date = new Date()): SweepFinding[] {
  const ctx = { locale: 'en-GB' } as unknown as RequestContext;
  const pages: Array<{ path: string; html: string }> = [
    { path: '/', html: renderLanding() },
    ...SITE_PAGES.map((page) => ({ path: page.path, html: render(page.path, platform, ctx) })),
  ];
  const live = livePosts(platform);
  const postPages = live.map((post) => ({ path: `/blog/${post.slug}`, html: render(`/blog/${post.slug}`, platform, ctx) }));

  // 1. Metadata: a title a result shows whole, a description it shows whole.
  const badMeta = pages
    .map((page) => ({ path: page.path, ...headOf(page.html) }))
    .filter((page) => page.title.length === 0 || page.title.length > SEO.titleMax || page.description.length < SEO.descriptionMin || page.description.length > SEO.descriptionMax)
    .map((page) => `${page.path} (title ${page.title.length}, description ${page.description.length})`);

  // 2. Sitemap: everything public, nothing else.
  const map = sitemap(platform);
  const expected = ['/', ...SITE_PAGES.map((page) => page.path), ...POST_PAGES.map((page) => page.path), ...publishedPosts(platform).map((post) => `/blog/${post.slug}`)];
  const missingFromMap = expected.filter((path) => !map.includes(`<loc>${config.publicBaseUrl.replace(/\/$/, '')}${path}</loc>`));
  const drafts = posts(platform).filter((post) => post.status !== 'PUBLISHED');
  const leakedToMap = drafts.filter((post) => map.includes(`/blog/${post.slug}</loc>`)).map((post) => post.slug);

  // 3. Robots: names the sitemap, keeps the crawler out of the application.
  const robotsText = robots();
  const robotsOk = /^Sitemap: https?:\/\/.+\/sitemap\.xml$/m.test(robotsText) && /^Disallow: \/app$/m.test(robotsText) && /^Disallow: \/unsubscribe$/m.test(robotsText);

  // 12. llms.txt: every public page named, every published post named, and the
  // two paths a machine must not follow said in prose rather than left out.
  const llmsText = llms(platform);
  const llmsMissing = [
    ...SITE_PAGES.map((page) => page.path),
    ...publishedPosts(platform).map((post) => `/blog/${post.slug}`),
  ].filter((path) => !llmsText.includes(`${config.publicBaseUrl.replace(/\/$/, '')}${path})`));
  const llmsOk = llmsText.startsWith('# CONSTRUX') && llmsMissing.length === 0 && llmsText.includes('/unsubscribe');

  // 4. Social cards: an absolute image, a card type, a title and a description on every page.
  const badCards = [...pages, ...postPages]
    .filter(
      (page) =>
        !/<meta property="og:image" content="https?:\/\/[^"]+">/.test(page.html) ||
        !/<meta name="twitter:card" content="[^"]+">/.test(page.html) ||
        !/<meta property="og:title" content="[^"]+">/.test(page.html) ||
        !/<meta property="og:description" content="[^"]+">/.test(page.html),
    )
    .map((page) => page.path);

  // 5. Structured data: parses on every page; a post is a BlogPosting.
  const badJsonLd = [...pages, ...postPages]
    .filter((page) => {
      const blocks = jsonLdBlocks(page.html);
      if (blocks.length === 0) return true;
      try {
        const parsed = blocks.map((block) => JSON.parse(block) as { '@type'?: string });
        return page.path.startsWith('/blog/') && !parsed.some((block) => block['@type'] === 'BlogPosting');
      } catch {
        return true;
      }
    })
    .map((page) => page.path);

  // 6. Hero imagery: the preview image exists, and the landing slots are filled.
  const heroPresent = existsSync(join(FRONTEND_DIR, 'landing-hero.png'));
  const slots = mediaState();
  const emptySlots = slots.filter((slot) => !slot.held).map((slot) => slot.id);

  // 7. Freshness: something published inside the window.
  const newest = live.map((post) => post.date).sort().at(-1) ?? '';
  const ageDays = newest === '' ? Number.POSITIVE_INFINITY : Math.floor((now.getTime() - new Date(`${newest}T00:00:00Z`).getTime()) / 86_400_000);

  // 8. Topic coverage.
  const coverage = topicCoverage(platform);
  const covered = coverage.filter((topic) => topic.covered).length;

  // 9. hreflang on every page.
  const noHreflang = [...pages, ...postPages]
    .filter((page) => !/<link rel="alternate" hreflang="en-GB" href="https?:\/\/[^"]+">/.test(page.html) || !/hreflang="x-default"/.test(page.html))
    .map((page) => page.path);

  // 10. Keyword coverage: every stored post carries its phrase where a result reads it.
  const stored = publishedPosts(platform);
  const offKeyword = stored
    .filter((post) => seoReport(post).some((finding) => (finding.check === 'Keyword in the title' || finding.check === 'Keyword in the opening') && !finding.ok))
    .map((post) => post.slug);

  // 11. Internal linking: at least two links into the site from every post
  // published from the console. The compiled notes are counted and named but
  // not scored — they predate the glossary, as they predate the keyword, and
  // are not rewritten to a standard they were never written to.
  const linkCounts = live.map((post) => ({
    slug: post.slug,
    stored: post.stored,
    links: hyperlink(post.body, { exclude: `/blog/${post.slug}` }).linked.length,
  }));
  const thinLinks = linkCounts.filter((post) => post.stored && post.links < MIN_INTERNAL_LINKS);
  const thinCompiled = linkCounts.filter((post) => !post.stored && post.links < MIN_INTERNAL_LINKS);

  return [
    {
      check: 'Page metadata',
      ok: badMeta.length === 0,
      weight: 12,
      detail:
        badMeta.length === 0
          ? `${pages.length} pages carry a title within ${SEO.titleMax} characters and a description between ${SEO.descriptionMin} and ${SEO.descriptionMax}.`
          : `Outside what a result shows whole: ${badMeta.join('; ')}. Posts are checked by their own gate, not here.`,
    },
    {
      check: 'Sitemap',
      ok: missingFromMap.length === 0 && leakedToMap.length === 0,
      weight: 10,
      detail:
        missingFromMap.length === 0 && leakedToMap.length === 0
          ? `${expected.length} public addresses listed; no draft leaks.`
          : `${missingFromMap.length > 0 ? `Missing: ${missingFromMap.join(', ')}. ` : ''}${leakedToMap.length > 0 ? `Drafts listed: ${leakedToMap.join(', ')}.` : ''}`,
    },
    {
      check: 'Robots',
      ok: robotsOk,
      // Two points lighter than it was, along with hreflang and hero imagery.
      // The three are binary presence checks that are rarely wrong and cheap to
      // fix, and the twelfth reader below — the assistant that answers instead
      // of listing — now costs more when it cannot describe the site than a
      // missing hreflang does on a site with one language.
      weight: 4,
      detail: robotsOk ? 'Names the sitemap; keeps crawlers out of /app and off the unsubscribe link.' : 'robots.txt is missing the sitemap line or a disallow the application depends on.',
    },
    {
      // The reader that answers the question instead of listing the links.
      // A growing share of the people who will ever consider this platform
      // never see a results page: they ask an assistant, which reads a few
      // pages and answers from them. This is the site described once, in
      // prose, at a fixed address — the same courtesy robots.txt is.
      check: 'llms.txt',
      ok: llmsOk,
      weight: 6,
      detail: llmsOk
        ? `Describes the site in prose and names every public page and post at /llms.txt.`
        : llmsMissing.length > 0
          ? `Public addresses an assistant would never be told about: ${llmsMissing.join(', ')}.`
          : 'llms.txt is malformed — it must open with the company name and say which paths must not be followed.',
    },
    {
      check: 'Social cards',
      ok: badCards.length === 0,
      weight: 10,
      detail: badCards.length === 0 ? `Every page and post carries an absolute preview image, a card type, a title and a description.` : `Incomplete cards on ${badCards.join(', ')}.`,
    },
    {
      check: 'Structured data',
      ok: badJsonLd.length === 0,
      weight: 8,
      detail: badJsonLd.length === 0 ? 'Organization data on every page; every post is a BlogPosting that parses.' : `Missing or unparseable on ${badJsonLd.join(', ')}.`,
    },
    {
      check: 'Hero imagery',
      ok: heroPresent && emptySlots.length === 0,
      weight: 4,
      detail: `${heroPresent ? 'The preview image is served.' : 'landing-hero.png, the image every share card points at, is not on disk.'} ${
        emptySlots.length === 0 ? `All ${slots.length} landing slots are filled.` : `${emptySlots.length} of ${slots.length} landing slots empty: ${emptySlots.join(', ')} — fill them on Company Profile.`
      }`,
    },
    {
      check: 'Freshness',
      /*
       * Eight of this check's twelve points went to `Editorial supply` below.
       *
       * The two are the same failure at different moments. Freshness fires
       * once the newest post is a fortnight old, by which time the damage is
       * done and the only available action is to have published something a
       * fortnight ago. Supply fires the day the library runs dry, which is the
       * day something can still be done about it. Weighting the warning above
       * the post-mortem is the point.
       */
      ok: ageDays <= FRESHNESS_DAYS,
      weight: 4,
      detail:
        newest === ''
          ? 'Nothing is published.'
          : `Newest post ${newest}, ${ageDays} day${ageDays === 1 ? '' : 's'} ago; a site reads as maintained inside ${FRESHNESS_DAYS}.`,
    },
    {
      check: 'Topic coverage',
      ok: covered === coverage.length,
      weight: 12,
      detail: `${covered} of ${coverage.length} topics have a published post${
        covered === coverage.length ? '.' : `; uncovered: ${coverage.filter((topic) => !topic.covered).map((topic) => topic.id).join(', ')}.`
      }`,
    },
    {
      /*
       * Whether the daily release has anything left to write about tomorrow.
       *
       * Separate from coverage on purpose, because they are opposite goods and
       * conflating them hides both. Full coverage is a pass — every subject the
       * business cares about has a page. Full coverage is also the exact
       * condition in which the release publishes nothing tomorrow, and the day
       * after, until somebody notices the site has gone stale.
       *
       * That happened. The ninth and last seeded topic was published on 6
       * September 2026 and the blog stopped, while this sweep reported a
       * perfect score throughout — because every check it ran was about what is
       * already on the site and none was about whether anything more was
       * coming.
       */
      check: 'Editorial supply',
      ok: coverage.length > covered,
      weight: 8,
      detail:
        coverage.length === 0
          ? 'The library is empty, so the daily release has nothing to publish. Add a topic on SEO & content.'
          : coverage.length === covered
            ? `Every one of the ${coverage.length} topics has a post, so tomorrow's release publishes nothing and the site starts ageing. It reads as abandoned after ${FRESHNESS_DAYS} days. Add a topic on SEO & content.`
            : `${coverage.length - covered} topic${coverage.length - covered === 1 ? '' : 's'} still to write, so the release has ${coverage.length - covered} more day${coverage.length - covered === 1 ? '' : 's'} of material.`,
    },
    {
      check: 'hreflang',
      ok: noHreflang.length === 0,
      weight: 2,
      detail: noHreflang.length === 0 ? 'en-GB and x-default declared on every page.' : `Missing on ${noHreflang.join(', ')}.`,
    },
    {
      check: 'Keyword coverage',
      ok: stored.length > 0 && offKeyword.length === 0,
      weight: 10,
      detail:
        stored.length === 0
          ? 'No post published from the console yet, so no page is targeting a phrase. The compiled notes carry no keyword by design.'
          : offKeyword.length === 0
            ? `${stored.length} published post${stored.length === 1 ? '' : 's'} carry their phrase in the title and the opening.`
            : `Phrase missing from the title or opening of ${offKeyword.join(', ')}.`,
    },
    {
      check: 'Internal linking',
      ok: stored.length > 0 && thinLinks.length === 0,
      weight: 10,
      detail:
        (stored.length === 0
          ? 'No post published from the console yet.'
          : thinLinks.length === 0
            ? `Every post published from the console links into the site at least ${MIN_INTERNAL_LINKS} times.`
            : `Under ${MIN_INTERNAL_LINKS} links: ${thinLinks.map((post) => `${post.slug} (${post.links})`).join(', ')}. Mention a phrase the glossary knows.`) +
        (thinCompiled.length > 0
          ? ` Compiled notes under ${MIN_INTERNAL_LINKS}, reported not scored: ${thinCompiled.map((post) => `${post.slug} (${post.links})`).join(', ')}.`
          : ''),
    },
  ];
}

export type SignalScore = { score: number; band: 'STRONG' | 'WORKABLE' | 'WEAK'; passing: number; total: number; summary: string };

/** The sweep as one number, with the reason the number is beside the checks and not instead of them. */
export function signalScore(findings: readonly SweepFinding[]): SignalScore {
  const total = findings.reduce((sum, finding) => sum + finding.weight, 0);
  const earned = findings.filter((finding) => finding.ok).reduce((sum, finding) => sum + finding.weight, 0);
  const score = total === 0 ? 0 : Math.round((earned / total) * 100);
  const failing = findings.filter((finding) => !finding.ok).sort((a, b) => b.weight - a.weight);
  return {
    score,
    band: score >= 90 ? 'STRONG' : score >= 65 ? 'WORKABLE' : 'WEAK',
    passing: findings.length - failing.length,
    total: findings.length,
    summary:
      failing.length === 0
        ? 'Every check passes. The site reads as complete, current and findable.'
        : `${failing.length} check${failing.length === 1 ? '' : 's'} failing, costliest first: ${failing.map((finding) => finding.check).join(', ')}.`,
  };
}

// --- The position -------------------------------------------------------------

export type Recommendation = {
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  detail: string;
  /** What the screen offers to do about it. Absent where the fix is outside the console. */
  action?: { label: string; command: 'library' | 'release' | 'generate' | 'distribute' | 'configure'; postId?: string };
};

/** Whether a real reasoning provider is configured, which decides what the generator button does. */
export function generatorMode(): { mode: 'TEMPLATE' | 'AI'; provider: string; note: string } {
  const provider = config.ai.reasoningProvider.toUpperCase();
  const key = provider === 'ANTHROPIC' ? config.ai.anthropicKey : provider === 'GEMINI' ? config.ai.geminiKey : config.ai.openaiKey;
  const live = config.ai.mode !== 'local' && key !== '';
  return live
    ? {
        mode: 'AI',
        provider,
        note:
          `${provider} is configured, so the generator asks the reasoning engine for an original article. It lands as a ` +
          'draft you publish: a model may draft, a person publishes.',
      }
    : {
        mode: 'TEMPLATE',
        provider: 'template',
        note:
          'No reasoning provider is configured, so the generator composes from the feature catalogue — sentences the ' +
          'product already publishes about itself — and may publish on the spot. Set AI_MODE and a provider key for original prose.',
      };
}

export function recommendations(platform: Platform, findings: readonly SweepFinding[]): Recommendation[] {
  const out: Recommendation[] = [];
  const failing = [...findings].filter((finding) => !finding.ok).sort((a, b) => b.weight - a.weight);
  const channels = distributionChannels();
  const configured = channels.filter((channel) => channel.configured);

  for (const finding of failing) {
    const priority: Recommendation['priority'] = finding.weight >= 10 ? 'HIGH' : 'MEDIUM';
    if (finding.check === 'Topic coverage') {
      out.push({ priority, title: 'Cover every topic', detail: finding.detail, action: { label: 'Generate marketing library', command: 'library' } });
    } else if (finding.check === 'Freshness') {
      out.push({ priority, title: 'Publish something this week', detail: finding.detail, action: { label: "Run today's release", command: 'release' } });
    } else if (finding.check === 'Keyword coverage') {
      out.push({ priority, title: 'Target a phrase', detail: finding.detail, action: { label: 'Generate a post', command: 'generate' } });
    } else {
      out.push({ priority, title: `Fix: ${finding.check}`, detail: finding.detail });
    }
  }

  const live = publishedPosts(platform);
  for (const post of live) {
    const sentTo = new Set(distributionsFor(platform, post.id).filter((entry) => entry.status === 'SENT').map((entry) => entry.channel));
    const unsent = configured.filter((channel) => !sentTo.has(channel.id));
    if (unsent.length > 0) {
      out.push({
        priority: 'MEDIUM',
        title: `Send "${post.title}" to ${unsent.map((channel) => channel.label).join(', ')}`,
        detail: 'Published and not yet sent to a channel that is configured. Reach is what a channel gives a page.',
        action: { label: 'Distribute', command: 'distribute', postId: post.id },
      });
    }
  }

  if (configured.length === 0) {
    out.push({
      priority: 'LOW',
      title: 'Configure a distribution channel',
      detail: `Nothing is configured, so a published post reaches only whoever finds the blog. Set ${channels
        .map((channel) => channel.missing.join(' and '))
        .join('; or ')}.`,
      action: { label: 'See the channels', command: 'configure' },
    });
  }

  if (generatorMode().mode === 'TEMPLATE') {
    out.push({
      priority: 'LOW',
      title: 'Configure a reasoning provider for original articles',
      detail: 'The template can only restate the feature catalogue. With a provider key set, the generator drafts original prose that a person publishes.',
    });
  }

  return out.slice(0, 10);
}

export type VisibilityPosition = {
  signal: SignalScore;
  sweep: SweepFinding[];
  reach: {
    requests: number;
    last30: number;
    shares: number;
    clicks: number;
    byChannel: Record<string, number>;
    durable: boolean;
    windowDays: number;
    note: string;
  };
  channels: ChannelStatus[];
  generator: ReturnType<typeof generatorMode>;
  topics: ReturnType<typeof topicCoverage>;
  releases: {
    today: MarketingRelease | null;
    recent: MarketingRelease[];
    schedule: { enabled: boolean; hourUtc: number; /** Eligible UTC weekdays, 1 = Monday. Empty is every day. */ daysUtc: number[] };
  };
  posts: Array<{
    id: string;
    slug: string;
    title: string;
    status: BlogPost['status'];
    tag: string;
    authorship: BlogPost['authorship'];
    publishedAt?: string;
    draftedAt: string;
    words: number;
    score: number;
    requests: number;
    shares: number;
    clicks: number;
    linked: number;
    kit: ShareKitEntry[];
    distributions: Distribution[];
  }>;
  recommendations: Recommendation[];
  limits: string[];
};

export function visibilityPosition(platform: Platform, now: Date = new Date()): VisibilityPosition {
  const sweep = seoSweep(platform, now);
  const views = viewsPosition();
  const byChannel: Record<string, number> = {};
  for (const entry of views.bySlug) {
    for (const [channel, count] of Object.entries(engagementFor(entry.slug).byChannel)) byChannel[channel] = (byChannel[channel] ?? 0) + count;
  }
  const all = releases(platform);
  const today = releaseDay(now);

  return {
    signal: signalScore(sweep),
    sweep,
    reach: {
      requests: views.total,
      last30: views.bySlug.reduce((sum, entry) => sum + entry.last30, 0),
      shares: views.shares,
      clicks: views.clicks,
      byChannel,
      durable: views.durable,
      windowDays: views.windowDays,
      note: views.note,
    },
    channels: distributionChannels(),
    generator: generatorMode(),
    topics: topicCoverage(platform),
    releases: {
      today: all.find((release) => release.day === today) ?? null,
      recent: all.slice(0, 7),
      schedule: {
        enabled: config.marketing.releaseEnabled,
        hourUtc: config.marketing.releaseHourUtc,
        daysUtc: [...config.marketing.releaseDaysUtc],
      },
    },
    posts: posts(platform).map((post) => {
      const engagement = post.status === 'PUBLISHED' ? engagementFor(post.slug) : { shares: 0, clicks: 0 };
      return {
        id: post.id,
        slug: post.slug,
        title: post.title,
        status: post.status,
        tag: post.tag,
        authorship: post.authorship,
        ...(post.publishedAt ? { publishedAt: post.publishedAt } : {}),
        draftedAt: post.draftedAt,
        words: wordsOf(post.body),
        score: seoScore(seoReport(post)).score,
        requests: post.status === 'PUBLISHED' ? (views.bySlug.find((entry) => entry.slug === post.slug)?.views ?? 0) : 0,
        shares: engagement.shares,
        clicks: engagement.clicks,
        linked: hyperlink(post.body.map((line) => esc(line)), { exclude: `/blog/${post.slug}` }).linked.length,
        kit: shareKit(post),
        distributions: distributionsFor(platform, post.id),
      };
    }),
    recommendations: recommendations(platform, sweep),
    limits: [
      'No ranking data. The platform does not query a search engine; the score says whether the site is complete and current, not where it ranks.',
      'Requests are not readers: a crawler counts, and one person reading twice counts twice. Shares and clicks are presses the page reported.',
      'A composed post restates the feature catalogue. It claims nothing the product does not already publish about itself, and it invents no figure.',
      'A channel sends only when its credential is set; a refusal is recorded with the network’s own answer, never retried silently.',
    ],
  };
}
