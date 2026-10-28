const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { MongoClient } = require("mongodb");

const port = Number(process.env.PORT || 3000);
const adminUser = process.env.ADMIN_USER;
const adminPassword = process.env.ADMIN_PASSWORD;

const painel = fs.readFileSync(
  path.join(__dirname, "painel.html"),
  "utf8"
);

let bancoStatus = "Testando conexão...";
let bancoPronto = false;
let client;
let ocupado = false;
let pedidosIA = [];
let tentativasLogin = [];

const autorizacoesML = new Map();

function iguais(a, b) {
  const hash = (valor) =>
    crypto
      .createHash("sha256")
      .update(String(valor ?? ""))
      .digest();

  return crypto.timingSafeEqual(hash(a), hash(b));
}

function autorizado(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;

  const texto = Buffer.from(
    header.slice(6),
    "base64"
  ).toString("utf8");

  const posicao = texto.indexOf(":");
  if (posicao < 0) return false;

  const usuarioCorreto = iguais(
    texto.slice(0, posicao),
    adminUser
  );

  const senhaCorreta = iguais(
    texto.slice(posicao + 1),
    adminPassword
  );

  return usuarioCorreto && senhaCorreta;
}

function json(res, status, dados) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(dados));
}

async function lerJson(req) {
  const partes = [];
  let tamanho = 0;

  for await (const parte of req) {
    tamanho += parte.length;

    if (tamanho > 20000) {
      throw new Error("Mensagem muito grande.");
    }

    partes.push(parte);
  }

  return JSON.parse(
    Buffer.concat(partes).toString("utf8")
  );
}

async function testarBanco() {
  bancoPronto = false;

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

    bancoPronto = true;
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

async function conversar(req, res) {
  const origem = req.headers.origin;
  const origemPermitida =
    "https://versaniche-vendas.onrender.com";

  if (origem !== origemPermitida) {
    return json(res, 403, {
      erro: "Origem não autorizada."
    });
  }

  const tipo = req.headers["content-type"] || "";
