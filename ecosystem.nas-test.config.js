// PM2 config for CHO Hub's NAS TEST instance (masinet.synology.me/choHubProject).
// Separate from ecosystem.config.js, which is for actual production on the VPS
// (app.connectedworkos.com, no subpath, own domain — see CLAUDE.md "Deployment").
//
// cwd is W:\choHubProject as seen from the NAS itself (/volume1/web/choHubProject) —
// NOT /volume1/NPM/choHubProject, which is N:\choHubProject (the dev source).
// watch:true means running `gulp build` from N:\ to sync files here is enough to
// trigger a restart — no separate flag-file/Task Scheduler watcher needed.
//
// Usage on the NAS:
//   pm2 start ecosystem.nas-test.config.js

module.exports = {
  apps: [
    {
      name: 'cho-hub-test',
      script: 'server.js',
      cwd: '/volume1/web/choHubProject',
      watch: ['config', 'middleware', 'migrations', 'public', 'routes', 'views', 'server.js'],
      ignore_watch: ['node_modules', '.git', 'logs'],
      env: {
        NODE_ENV: 'production',
        BASE_PATH: '/choHubProject',
        PORT: 3001,
      },
    },
  ],
};
