const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bcrypt = require('bcrypt');
const db = require('./db');

// These lookups deliberately use the unscoped pool, not config/scopedDb: authentication
// is what *establishes* the org, so there is no org context to scope by yet. Since
// migration 030 made users.email unique per-org rather than globally, an email could in
// principle match staff rows in two orgs — see docs/adr/0001-multi-tenancy.md phase 3,
// which adds org selection at login. Harmless while org 1 is the only tenant.

// Staff-only auth. Customers never log in — they use signed token links (see middleware/customerAccess.js).
passport.use(
  new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
    try {
      const [rows] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
      const user = rows[0];
      if (!user || !user.password_hash || !user.active) return done(null, false, { message: 'Invalid email or password' });

      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) return done(null, false, { message: 'Invalid email or password' });

      await db.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  })
);

// Google sign-in only attaches to an existing staff row by email — unlike gymrProject's
// public-signup flow, it never creates a new user. An unrecognized Google account must
// not gain access just by authenticating; staff accounts are provisioned via
// scripts/create-admin.js first.
if (process.env.GOOGLE_CLIENT_ID) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL,
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value?.toLowerCase();
          const avatarUrl = profile.photos?.[0]?.value || null;
          if (!email) return done(null, false, { message: 'Google account has no email' });

          const [rows] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
          const user = rows[0];
          if (!user) return done(null, false, { message: 'No staff account found for this Google email' });
          if (!user.active) return done(null, false, { message: 'This staff account has been deactivated' });

          await db.execute(
            'UPDATE users SET google_id = ?, avatar_url = ?, last_login = NOW() WHERE id = ?',
            [profile.id, avatarUrl, user.id]
          );
          return done(null, user);
        } catch (err) {
          return done(err);
        }
      }
    )
  );
}

passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
  try {
    // org_id is required here: middleware/orgContext.js builds this request's scoped
    // db handle from it, so omitting it leaves every staff request tenant-less.
    const [rows] = await db.execute(
      'SELECT id, org_id, email, name, role, avatar_url FROM users WHERE id = ?',
      [id]
    );
    done(null, rows[0] || false);
  } catch (err) {
    done(err);
  }
});

module.exports = passport;
