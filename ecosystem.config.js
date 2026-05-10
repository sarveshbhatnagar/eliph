module.exports = {
  apps: [
    {
      name: 'eliph-api',
      script: 'dist/server.js',
      cwd: '/Users/sarvesh/Desktop/eliph',
      instances: 1,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 2000,
      env: {
        NODE_ENV: 'production',
        ADMIN_SECRET: 'replace-with-a-long-random-secret',
      },
    },
  ],
}
