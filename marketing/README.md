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

## Contrast audit

Three separate light-on-light bugs shipped before this was written, all the same shape: a
component sets its own light `background` but not its own `color`, so when it lands inside
a `.field` blueprint band it inherits `#dceaf5` and renders pale text on white. The rule
that prevents it:

> **Anything that paints its own background must also state its own colour.**

Links have the mirror problem — the base `a` colour is tuned for light sections and drops
to 2.1:1 on the blueprint, which is why `.field a:not(.btn)` exists.

To re-check the whole site, serve it locally and run this in the console of a page that
loads every route in same-origin iframes. It walks every element that renders its own
text, resolves the first opaque background behind it, and reports anything under WCAG AA
(4.5:1, or 3:1 for large text):

```js
function srgb(c){c/=255;return c<=0.03928?c/12.92:Math.pow((c+0.055)/1.055,2.4);}
function lum(p){return 0.2126*srgb(p[0])+0.7152*srgb(p[1])+0.0722*srgb(p[2]);}
function parse(c){const m=c.match(/[\d.]+/g);if(!m)return null;
  return{rgb:[+m[0],+m[1],+m[2]],a:m.length>3?parseFloat(m[3]):1};}
function ratio(f,b){const L1=lum(f),L2=lum(b);
  return (Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05);}
function effBg(el,w){let n=el;while(n&&n.nodeType===1){
  const c=parse(w.getComputedStyle(n).backgroundColor);
  if(c&&c.a>0.9)return c.rgb;n=n.parentElement;}return[255,255,255];}

for (const fr of document.querySelectorAll('iframe')) {
  const d=fr.contentDocument, w=fr.contentWindow;
  for (const el of d.querySelectorAll('body *')) {
    if(![...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim().length>1)) continue;
    const cs=w.getComputedStyle(el);
    if(cs.visibility==='hidden'||cs.display==='none') continue;
    const fg=parse(cs.color); if(!fg||fg.a<0.5) continue;
    const r=ratio(fg.rgb,effBg(el,w));
    const size=parseFloat(cs.fontSize), bold=parseInt(cs.fontWeight,10)>=700;
    const min=(size>=24||(size>=18.66&&bold))?3:4.5;
    if(r<min) console.warn(r.toFixed(2)+'/'+min, el);
  }
}
```

Last run: 505 text elements across all 7 pages, 0 failures, closest passing 5.52.
