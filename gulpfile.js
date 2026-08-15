const { series, parallel, watch, src, dest } = require("gulp"),
      changed = require("gulp-changed"),
      del     = require("del"),
      path    = require("path");

// Mirrors gymrProject's gulpfile.js pattern (N:\gymrProject\gulpfile.js) — same NAS,
// N: is the source/dev drive, W: is the test-hosting share. Unlike gymrProject, this
// app has no separate src/ front-end authoring layer yet (public/css, public/js are
// already the served files), so there's nothing to bundle — this just mirrors the
// whole app to W:\. If a bundled front-end pipeline gets added later, add bundle_js/
// bundle_css tasks here matching gymrProject's shape.

const paths = {
  dist: "W://choHubProject/",
  app: [
    "**/*",
    "!node_modules/**",
    "!node_modules",
    "!.git/**",
    "!.git",
    "!.env",
    "!.env.example",
    "!gulpfile.js",
    // Encrypted secrets vault — dev machine ONLY. It is the offline copy of every
    // environment's .env, so it must never reach W: (the NAS test share) or, via git,
    // production. Also in .gitignore. See scripts/secrets-vault.js.
    "!*.vault",
    // Environment-specific data, not source — each environment (local dev, NAS test)
    // keeps its own uploaded consultation photos rather than mirroring one onto the
    // other.
    "!uploads/**",
    "!uploads",
    // The public marketing site (connectedworkos.com). It is served by its own nginx
    // vhost straight from the git checkout on the VPS — it is not part of the Express
    // app, so the NAS test instance has no use for it. See marketing/README.md.
    "!marketing/**",
    "!marketing",
  ],
};

// Copies Bootstrap's pre-built dist files into public/vendor/ so the app serves them
// same-origin instead of from a CDN — a jsdelivr 503 broke every collapse/dropdown
// on the site (Bootstrap's JS never loaded) despite the CSS loading fine. bootstrap/
// bootstrap-icons are devDependencies only: nothing server-side ever require()s them,
// so the NAS doesn't need them in its own node_modules — the copied files under
// public/vendor/ are what actually ships and gets synced by move_app below.
function copy_vendor_bootstrap() {
  return src("node_modules/bootstrap/dist/**/*", { base: "node_modules/bootstrap/dist" })
    .pipe(dest("public/vendor/bootstrap"));
}

function copy_vendor_icons() {
  return src("node_modules/bootstrap-icons/font/**/*", { base: "node_modules/bootstrap-icons/font" })
    .pipe(dest("public/vendor/bootstrap-icons"));
}

const copy_vendor = parallel(copy_vendor_bootstrap, copy_vendor_icons);

function move_app() {
  return src(paths.app, { base: ".", dot: false })
    .pipe(changed(paths.dist))
    .pipe(dest(paths.dist));
}

function watch_app(callback) {
  watch(paths.app, series(move_app))
    .on("unlink", function (filePath) {
      const relPath  = path.relative(path.resolve("."), filePath);
      const destPath = path.resolve(paths.dist, relPath);
      del(destPath, { force: true }).then((deleted) => {
        console.log("Deleted:\n", deleted.join("\n"));
      });
    })
    .on("change", function (filePath) {
      console.log("Changed: " + filePath);
    });
  callback();
}

exports.build = series(copy_vendor, move_app);
exports.default = series(copy_vendor, move_app, watch_app);
