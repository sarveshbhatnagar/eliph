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
        ADMIN_SECRET: '2300ef5042c5d91d8ebde8366ef6f457452dfbd3daee99d8d41b7c473a708e1f',
        JWT_SECRET: 'c36e0c076aa98b5aa281248a1b76c0d9a3410d8ee93f592fe569103a2ca5687b',
      },
    },
    {
      name: 'eliph-mcp',
      script: 'dist/mcp-server.js',
      cwd: '/Users/sarvesh/Desktop/eliph',
      instances: 1,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 2000,
      env: {
        NODE_ENV: 'production',
        ELIPH_API_URL: 'http://localhost:4000',
        MCP_PORT: '4002',
      },
    },
  ],
}
