// The 60-second product tour — one source for everything that describes it: the /tour watch
// page (player, chapters, transcript, VideoObject JSON-LD), the transcript under the home page
// hero, and the video entry build.js writes into sitemap.xml.
//
// The video is silent with burned-in captions, so this transcript is the only text a crawler
// or screen reader gets from it. Keep it in step with tools/explainer-video/explainer.html
// whenever the video is re-rendered — a price or copy change there must change here too.
//
// Chapters match the chapter bar drawn in the video itself and meet YouTube's chapter rules
// (first at 0:00, at least three, each at least 10 seconds), so the same list can be pasted
// into a YouTube description. Same shape as gymrProject/config/tourVideo.js (the Ledger tour).

const ORIGIN = 'https://connectedworkos.com';

const tour = {
  name:        'ConnectedWorkOS — 60-second tour',
  description: 'A 60-second tour of ConnectedWorkOS for small service businesses: a quote priced from your own list with the margin showing, signed online, a card deposit into your own Stripe or Square account, the job scheduled and the balance invoiced automatically, and every payment posted into Connected Home Ledger.',
  // Full ISO 8601 with a timezone — Search Console flags a bare date as "missing a timezone"
  // and "invalid datetime" for VideoObject.uploadDate. Central time (CDT in October).
  uploadDate:  '2026-10-26T09:00:00-05:00',
  durationSec: 60,
  src:         '/video/workos-tour-720.mp4',
  poster:      '/video/workos-tour-poster.jpg',
  watchUrl:    `${ORIGIN}/tour`,
  contentUrl:  `${ORIGIN}/video/workos-tour-720.mp4`,
  thumbnailUrl: `${ORIGIN}/video/workos-tour-poster.jpg`,
  // The 1080p master (tools/explainer-video/youtube.txt has the description); the watch page
  // shows a "Watch on YouTube" link only when this is set.
  youtubeUrl:  'https://youtu.be/14wlOGAkwCw',

  chapters: [
    {
      start: 0, label: 'The quote',
      lines: [
        'ConnectedWorkOS: every job, start to paid. Quote it, get it signed, take the deposit, do the work, bill the balance.',
        'The quote, priced from your own list: materials, labour and subcontracted work from your price list — or start from a job you’ve quoted before.',
        'Cost sits beside price on every line, so you see the margin before you send it.',
      ],
    },
    {
      start: 17, label: 'Signed & paid',
      lines: [
        'Signed online, deposit paid. Your customer opens a link — no account, no app, no password.',
        'They sign, pay the deposit by card, and it lands in your own Stripe or Square account. The signature is kept with the time and the address it came from.',
      ],
    },
    {
      start: 30, label: 'The work',
      lines: [
        'Scheduled, done, billed. The job lands on the calendar and on the crew’s list, with the material list ready for the truck.',
        'Mark it done and the balance invoices itself — net of the deposit. Nobody forgets the last invoice, and the warranty is on record.',
      ],
    },
    {
      start: 43, label: 'Your books',
      lines: [
        'Your books fill themselves in. Every payment posts to Connected Home Ledger as business income — dated, categorised and net of refunds. Nothing to retype.',
        'ConnectedWorkOS is included with the Connected Home Ledger Business+ plan, at $29 a month or $290 a year. Your own Stripe or Square account, and no cut of your jobs. Start with Connected Home Ledger.',
      ],
    },
  ],
};

// "0:45" style timestamp, as YouTube and the chapter list show it
tour.stamp = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

// Plain-text transcript, one paragraph per line
tour.transcriptText = () => tour.chapters.flatMap(c => c.lines).join('\n\n');

// VideoObject for the watch page. Clip markup gives Google "key moments"; each clip's url must
// open the video at that offset, which is what ?t=NN does on /tour.
tour.jsonld = () => ({
  '@context': 'https://schema.org',
  '@type': 'VideoObject',
  name: tour.name,
  description: tour.description,
  thumbnailUrl: [tour.thumbnailUrl],
  uploadDate: tour.uploadDate,
  duration: 'PT' + tour.durationSec + 'S',
  contentUrl: tour.contentUrl,
  embedUrl: tour.watchUrl,
  inLanguage: 'en-US',
  transcript: tour.chapters.map(c => c.lines.join(' ')).join(' '),
  hasPart: tour.chapters.map((c, i) => {
    const next = tour.chapters[i + 1];
    return { '@type': 'Clip', name: c.label, startOffset: c.start,
             endOffset: next ? next.start : tour.durationSec, url: `${tour.watchUrl}?t=${c.start}` };
  }),
  publisher: { '@type': 'Organization', name: 'Connected Home Outfitters LLC',
               logo: { '@type': 'ImageObject', url: `${ORIGIN}/img/favicon.png` } },
});

module.exports = tour;
