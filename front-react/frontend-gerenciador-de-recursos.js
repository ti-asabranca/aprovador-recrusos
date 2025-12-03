const express = require('express');
const path = require('path');
const app = express();

const hostname = '192.168.0.21';
const port = 9002;

// Serve os arquivos estáticos do React
app.use(express.static(path.join(__dirname, 'build')));

// Em qualquer rota, serve o index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

app.listen(port, hostname, () => {
  console.log(`🟢 Frontend rodando em http://${hostname}:${port}`);
});
