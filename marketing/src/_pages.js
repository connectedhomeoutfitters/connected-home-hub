// The page manifest. One entry per page — build.js renders each one and generates
// sitemap.xml from this same list, so a new page cannot be added to the site while being
// forgotten in the sitemap.
//
// `nav` is the label in the header; omit it to keep a page out of the nav (it still gets
// built and listed in the sitemap).

module.exports = [
  {
    slug: 'index',
    url: '/',
    title: 'ConnectedWorkOS — job, quote and payment software for small service businesses',
    description:
      'ConnectedWorkOS runs the whole job for lawn care, repair, HVAC, plumbing, cleaning and other small service businesses: quotes with e-signature, card deposits, scheduling, job costing and final invoices. Every payment you collect posts straight into your books.',
    priority: '1.0',
    changefreq: 'weekly',
  },
  {
    slug: 'how-it-works',
    url: '/how-it-works',
    nav: 'How it works',
    title: 'How it works — quote, sign, deposit, schedule, invoice | ConnectedWorkOS',
    description:
      'See a real job run end to end: a quote your customer signs online, a card deposit, the work scheduled, and the balance invoiced automatically when it is done. With examples of each document.',
    priority: '0.9',
    changefreq: 'monthly',
  },
  {
    slug: 'getting-paid',
    url: '/getting-paid',
    nav: 'Getting paid',
    title: 'Getting paid — card deposits and invoices through your own Stripe account | ConnectedWorkOS',
    description:
      'How payments work in ConnectedWorkOS: connect your own Stripe account, take card deposits when a quote is accepted, invoice the balance, and handle refunds. What Stripe asks for, what it costs, and when you get paid.',
    priority: '0.9',
    changefreq: 'monthly',
  },
  {
    slug: 'faq',
    url: '/faq',
    nav: 'FAQ',
    title: 'Frequently asked questions | ConnectedWorkOS',
    description:
      'Do I need Stripe? What are the fees? Do my customers need an account? Do I have to use Connected Home Ledger? Straight answers about ConnectedWorkOS.',
    priority: '0.7',
    changefreq: 'monthly',
  },

  // Trade pages: the same product in each trade's own language, because people search by
  // what they do, not by "field service software". Kept to three real ones rather than a
  // rack of thin near-duplicates — each says something specific to that trade.
  {
    slug: 'lawn-care',
    url: '/lawn-care',
    title: 'Lawn care & landscaping software — quotes, scheduling and invoicing | ConnectedWorkOS',
    description:
      'Quote a property, get it signed, take a deposit and invoice the balance. Built for lawn care and landscaping crews who bill per job, not per hour on a clipboard.',
    priority: '0.8',
    changefreq: 'monthly',
  },
  {
    slug: 'hvac',
    url: '/hvac',
    title: 'HVAC software for small shops — quotes, deposits, invoicing and warranties | ConnectedWorkOS',
    description:
      'Quote a replacement, take the deposit on acceptance, schedule the install and record the equipment warranty. For HVAC shops that want the paperwork to keep up with the truck.',
    priority: '0.8',
    changefreq: 'monthly',
  },
  {
    slug: 'plumbing',
    url: '/plumbing',
    title: 'Plumbing software — estimates, card payments and job invoicing | ConnectedWorkOS',
    description:
      'Price the job from your own list, get it approved on the spot, take payment by card and bill the balance when the work is done. For plumbing shops with a truck, not a call centre.',
    priority: '0.8',
    changefreq: 'monthly',
  },
];
