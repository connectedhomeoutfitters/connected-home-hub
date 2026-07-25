module.exports = {
  apps: [
    {
      name: 'cho-hub',
      script: 'server.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        BASE_PATH: '',
      },
    },
  ],
};
