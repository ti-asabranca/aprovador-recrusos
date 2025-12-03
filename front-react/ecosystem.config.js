module.exports = {
    apps: [
      {
        name: "frontend-gerenciador-de-recurso",
        script: "C:/Users/administrador.ASABRANCANET/AppData/Roaming/npm/serve",
        args: "build -s -l 9002",
        watch: false,
        env: {
          NODE_ENV: "production"
        }
      }
    ]
  };
  