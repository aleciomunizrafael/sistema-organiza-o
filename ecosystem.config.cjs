// Configuração do pm2: mantém o Organiza rodando e reinicia se cair.
// Uso: npm install -g pm2 && pm2 start ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [
    {
      name: 'organiza',
      script: 'src/index.js',
      node_args: '--disable-warning=ExperimentalWarning',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: '400M',
      env: {
        NODE_ENV: 'production',
      },
      out_file: 'data/pm2-out.log',
      error_file: 'data/pm2-err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
