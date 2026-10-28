const http = require("node:http");

const port = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {
  const path = req.url.split("?")[0];

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (path === "/") {
    res.writeHead(200);
    res.end(`
      <!doctype html>
      <html lang="pt-BR">
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width">
        <title>Versaniche Vendas</title>
        <body style="font-family:Arial;padding:40px">
          <h1>Versaniche Vendas</h1>
          <p>Servidor funcionando!</p>
          <p>Próxima etapa: configurar Mercado Livre e MongoDB.</p>
        </body>
      </html>
    `);
    return;
  }

  if (path === "/api/mercadolivre/callback") {
    res.writeHead(503);
    res.end("A integração ainda está em configuração.");
    return;
  }

  res.writeHead(404);
  res.end("Página não encontrada.");
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Servidor iniciado na porta ${port}`);
});
