const http = require("node:http");
const crypto = require("node:crypto");
const { MongoClient } = require("mongodb");

const port = Number(process.env.PORT || 3000);
const adminUser = process.env.ADMIN_USER;
const adminPassword = process.env.ADMIN_PASSWORD;

let bancoStatus = "Testando conexão...";
let client;

function iguais(a, b) {
  const hash = (valor) =>
    crypto.createHash("sha256").update(valor).digest();

  return crypto.timingSafeEqual(hash(a), hash(b));
}

function autorizado(req) {
  if (!adminUser || !adminPassword) return false;

  const authorization = req.headers.authorization || "";
  if (!authorization.startsWith("Basic ")) return false;

  const credenciais = Buffer.from(
    authorization.slice(6),
    "base64"
  ).toString("utf8");

  const separador = credenciais.indexOf(":");
  if (separador < 0) return false;

  const usuario = credenciais.slice(0, separador);
  const senha = credenciais.slice(separador + 1);

  const usuarioCorreto = iguais(usuario, adminUser);
  const senhaCorreta = iguais(senha, adminPassword);

  return usuarioCorreto && senhaCorreta;
}

async function testarBanco() {
  if (!process.env.MONGODB_URI) {
    bancoStatus = "Falta configurar MONGODB_URI.";
    return;
  }

  try {
    client = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 10000,
      maxPoolSize: 5
    });

    await client.connect();
    await client.db("admin").command({ ping: 1 });

    bancoStatus = "MongoDB conectado com sucesso!";
    console.log(bancoStatus);
  } catch {
    bancoStatus = "Falha na conexão com o MongoDB.";
    console.log(bancoStatus);

    if (client) {
      await client.close().catch(() => {});
    }
  }
}

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (!adminUser || !adminPassword) {
    res.writeHead(503);
    res.end("Acesso indisponível: configure as credenciais no Render.");
    return;
  }

  if (!autorizado(req)) {
    res.setHeader(
      "WWW-Authenticate",
      'Basic realm="Versaniche Vendas", charset="UTF-8"'
    );
    res.writeHead(401);
    res.end("Entre com seu usuário e senha para acessar.");
    return;
  }

  const path = (req.url || "/").split("?")[0];

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
          <p>Acesso autorizado ao painel.</p>

          <h2>Banco de dados</h2>
          <p>${bancoStatus}</p>

          <h2>Mercado Livre</h2>
          <p>Integração pendente de configuração.</p>

          <h2>Vendas</h2>
          <p>Nenhuma venda importada ainda.</p>
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
