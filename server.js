const http = require("node:http");
const { MongoClient } = require("mongodb");

const port = Number(process.env.PORT || 3000);
let bancoStatus = "Testando conexão...";
let client;

async function testarBanco() {
  if (!process.env.MONGODB_URI) {
    bancoStatus = "Falta configurar MONGODB_URI no Render.";
    console.log(bancoStatus);
    return;
  }

  try {
    client = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      maxPoolSize: 5
    });

    await client.connect();
    await client.db("admin").command({ ping: 1 });

    bancoStatus = "MongoDB conectado com sucesso!";
    console.log(bancoStatus);
  } catch {
    bancoStatus =
      "Não foi possível conectar ao MongoDB. Confira a configuração.";
    console.log(bancoStatus);

    if (client) {
      await client.close().catch(() => {});
    }
  }
}

const server = http.createServer((req, res) => {
  const path = req.url.split("?")[0];

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (path === "/") {
    res.writeHead(200);
    res.end(`
      <!doctype html>
      <html lang="pt-BR">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width">
          <title>Versaniche Vendas</title>
        </head>
        <body style="font-family:Arial;padding:40px">
          <h1>Versaniche Vendas</h1>
          <p>Servidor funcionando!</p>
          <h2>Teste do banco de dados</h2>
          <p>${bancoStatus}</p>
          <p>A integração com o Mercado Livre ainda está pendente.</p>
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
  testarBanco();
});
