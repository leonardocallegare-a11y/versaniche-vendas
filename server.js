const http = require("node:http");
const { MongoClient } = require("mongodb");

const port = Number(process.env.PORT || 3000);

let bancoStatus = "Testando conexão...";
let client;

async function testarBanco() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    bancoStatus = "Falta configurar MONGODB_URI no Render.";
    console.log(bancoStatus);
    return;
  }

  if (uri.includes("<db_password>")) {
    bancoStatus =
      "O endereço ainda contém <db_password>. Insira a senha do banco no Render.";
    console.log(bancoStatus);
    return;
  }

  try {
    client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 10000,
      maxPoolSize: 5
    });

    await client.connect();
    await client.db("admin").command({ ping: 1 });

    bancoStatus = "MongoDB conectado com sucesso!";
    console.log(bancoStatus);
  } catch (erro) {
    if (erro.code === 18 || erro.code === 8000) {
      bancoStatus =
        "Falha de autenticação: conferir usuário e senha do banco.";
    } else if (erro.name === "MongoParseError") {
      bancoStatus =
        "O endereço MONGODB_URI está em formato inválido.";
    } else if (
      erro.code === "ENOTFOUND" ||
      erro.code === "ESERVFAIL" ||
      erro.code === "ECONNREFUSED"
    ) {
      bancoStatus =
        "Falha de rede ou DNS: conferir o endereço do cluster.";
    } else if (erro.name === "MongoServerSelectionError") {
      bancoStatus =
        "Não foi possível alcançar o cluster: conferir rede, IPs autorizados e disponibilidade.";
    } else {
      bancoStatus =
        "Falha de conexão ainda não identificada.";
    }

    console.log(bancoStatus);

    if (client) {
      await client.close().catch(() => {});
    }
  }
}

function escaparHtml(texto) {
  return texto
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const server = http.createServer((req, res) => {
  const path = (req.url || "/").split("?")[0];

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
          <p>${escaparHtml(bancoStatus)}</p>

          <p>
            A integração com o Mercado Livre ainda está pendente.
          </p>
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
