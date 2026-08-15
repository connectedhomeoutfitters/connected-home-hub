# ConnectedWorkOS marketing site

The public site at **https://connectedworkos.com** (and `www.`). Plain static HTML and
CSS — no build step, no Node process, no database.

It lives in this repo because it ships with the same `git pull` the app does, but it is
**not part of the Express app**. nginx serves this directory directly:

```
connectedworkos.com      ─┐
www.connectedworkos.com  ─┴─> /var/www/cho-hub/marketing   (static, nginx only)
app.connectedworkos.com  ───> 127.0.0.1:3100               (the Hub app, PM2)
```

Consequences worth knowing:

- **A broken page here cannot take the app down.** Different vhost, different root, no
  shared process. Editing this needs no `pm2 restart` — nginx picks up the new file on
  the next request.
- **It is excluded from the gulp NAS sync** (`gulpfile.js`), since the NAS test instance
  runs the app, not the marketing site.
- **Deploy is just `git pull` on the VPS.** No migration, no restart.

## Files

| File | Purpose |
|---|---|
| `index.html` | The whole page. Single file, semantic sections, JSON-LD for search. |
| `styles.css` | All styling. Design tokens are at the top in `:root`. |
| `img/logo.png` | Same ConnectedWorkOS mark the app uses as its default logo. |
| `img/favicon.png` | 256px app icon, generic fallback. |
| `img/favicon-32.png` | 32px — what a browser tab actually renders on a 2× display. |
| `img/apple-touch-icon.png` | 180px, iOS home screen. |

## Design notes

The direction is **blueprint** — the drawing language of the trades this sells to, rather
than a generic SaaS gradient. Deep drafting blue, a fine grid, hairline rules, mono
annotations.

Two rules that are easy to break by accident:

- **Hi-vis amber (`--hivis`) means money.** It is used only on the primary CTA and on the
  two lifecycle steps where cash moves (deposit, final balance). Spending it on ordinary
  accents destroys the one thing the colour encodes.
- **The glow belongs to the hero only** (`.field--glow`). Every blueprint band shares
  `.field`; repeating the glow on all of them turns a signature into wallpaper.

The signature element is the **run**: a conduit line with a connector node per lifecycle
step, drawn from the pin-and-trace motif in the logo. Each step is given its own grid row
(`.stage:nth-child(n)`) rather than left to auto-placement — otherwise steps 1 and 2 share
the first row and the sequence reads as two parallel columns instead of one line.

## Editing copy

**Audience: small service businesses generally** — lawn care, repair and handyman, HVAC,
plumbing, electrical, cleaning, pest control, appliance repair, pool, pressure washing.
Deliberately **not** pitched at smart-home / low-voltage / AV: that is Connected Home
Outfitters' own market, and this page would be advertising to its owner's competitors.
Keep new copy trade-neutral — say "quote", "job", "price list", "materials", not
"install", "rough-in" or "structured wiring".

Every claim on this page describes something that is actually built. If you add a claim,
check it against `CLAUDE.md` first. The funnel the page is written for is:

> sign up for Connected Home Ledger → set up a Business Workspace → open ConnectedWorkOS

so the primary CTA points at Ledger, not at a signup form here (there is no self-signup).

The "Book a walkthrough" link is a `mailto:` to `chris@connectedhomeoutfitters.com`.
Swap it for a product address once one exists.

## Local preview

```bash
npx http-server marketing -p 8790     # or any static server
```

Check it at 360px and 390px wide before shipping — the run, the split, and the card grids
all change shape on the way down.
