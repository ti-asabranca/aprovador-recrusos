module.exports = {
    apps: [
      {
        name: "api-gerenciador-de-recursos",
        script: "getfilespr.js",
        env: {
          NODE_ENV: "production",
          HOST: "192.168.0.21",
          PORT: 7000
        }
      }
    ]
  };
  