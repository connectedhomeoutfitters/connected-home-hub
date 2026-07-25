const express = require('express');
const router = express.Router();
const passport = require('../config/passport');
const { redirectIfAuth } = require('../middleware/auth');

const BASE_PATH = process.env.BASE_PATH || '';
const googleEnabled = !!process.env.GOOGLE_CLIENT_ID;

router.get('/login', redirectIfAuth, (req, res) => {
  res.render('auth/login', { pageScript: null, error: null, googleEnabled });
});

router.post(
  '/login',
  passport.authenticate('local', {
    successRedirect: `${BASE_PATH}/`,
    failureRedirect: `${BASE_PATH}/login`,
  })
);

if (googleEnabled) {
  router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'], prompt: 'select_account' }));

  router.get(
    '/google/callback',
    passport.authenticate('google', { failureRedirect: `${BASE_PATH}/login`, keepSessionInfo: true }),
    (req, res) => res.redirect(`${BASE_PATH}/`)
  );
}

router.post('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.redirect(`${BASE_PATH}/login`);
  });
});

module.exports = router;
