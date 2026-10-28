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
let client;
let ocupado = false;
let pedidosIA = [];
let tentativasLogin = [];

function iguais(a, b) {
  const hash = (valor) =>
    crypto.createHash("sha256").update(valor).digest();

  return crypto.timingSafeEqual(hash(a), hash(b));
}

function autorizado(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;

  const texto = Buffer.from(
    header.slice(6), "base64"
  ).toString("utf8");

  const posicao = texto.indexOf(":");
  if (posicao < 0) return false;

  const usuarioCorreto = iguais(
    texto.slice(0, posicao), adminUser
  );

  const senhaCorreta = iguais(
    texto.slice(posicao + 1), adminPassword
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

  return JSON.parse(Buffer.concat(partes).toString("utf8"));
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
    if (client) await client.close().catch(() => {});
  }
}

async function conversar(req, res) {
  const origem = req.headers.origin;
  const origemPermitida =
    "https://versaniche-vendas.onrender.com";

  if (origem !== origemPermitida) {
    return json(res, 403, { erro: "Origem não autorizada." });
  }

  const tipo = req.headers["content-type"] || "";
  if (!tipo.startsWith("application/json")) {
    return json(res, 415, { erro: "Formato inválido." });
  }

  if (!process.env.OPENAI_API_KEY) {
    return json(res, 503, {
      erro: "Falta configurar OPENAI_API_KEY no Render."
    });
  }

  let dados;
  try {
    dados = await lerJson(req);
  } catch {
    return json(res, 400, {
      erro: "Mensagem inválida ou muito grande."
    });
  }

  if (!Array.isArray(dados?.mensagens)) {
    return json(res, 400, { erro: "Conversa inválida." });
  }

  const mensagens = dados.mensagens;

  const valido =
    mensagens.length > 0 &&
    mensagens.length <= 12 &&
    mensagens.every((m) =>
      m &&
      ["user", "assistant"].includes(m.role) &&
      typeof m.content === "string" &&
      m.content.trim().length > 0 &&
      m.content.length <= 2000
    ) &&
    mensagens[mensagens.length - 1].role === "user";

  if (!valido) {
    return json(res, 400, {
      erro: "Use mensagens de até 2.000 caracteres."
    });
  }

  const agora = Date.now();
  pedidosIA = pedidosIA.filter((t) => agora - t < 60000);

  if (ocupado || pedidosIA.length >= 8) {
    return json(res, 429, {
      erro: "Aguarde a resposta ou tente novamente em um minuto."
    });
  }

  ocupado = true;
  pedidosIA.push(agora);

  try {
    const resposta = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        signal: AbortSignal.timeout(45000),
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
          store: false,
          max_output_tokens: 700,
          instructions: `
Você é o Jarvis, assistente de gestão da Versaniche.
Responda em português brasileiro, com clareza e objetividade.
O responsável prefere ser chamado de Chefe Supremo.
A empresa trabalha com filamentos e produtos de impressão 3D.

Nesta versão você NÃO tem acesso às vendas, estoque,
custos, mensagens de clientes ou anúncios do Mercado Livre.
Você NÃO pode publicar anúncios, alterar preços ou criar ofertas.
Não existe ferramenta de consulta ao banco disponível para você.
Nunca afirme que consultou dados ou executou ações.
Use apenas informações fornecidas na conversa.
Diferencie fatos informados, hipóteses e sugestões.
Para cálculos, explique as premissas e peça dados que faltarem.
Pode ajudar a planejar, analisar dados fornecidos e redigir anúncios.
Não peça senhas, tokens nem chaves de API.
          `,
          input: mensagens
        })
      }
    );

    const resultado = await resposta.json().catch(() => ({}));

    if (!resposta.ok) {
      let erro = "A IA não respondeu. Tente novamente depois.";

      if (resposta.status === 401) {
        erro = "A chave da OpenAI não foi aceita.";
      } else if (resposta.status === 403) {
        erro = "A chave não tem permissão para esse recurso.";
      } else if (
        resultado.error?.code === "insufficient_quota"
      ) {
        erro = "Confira os créditos e a cobrança da API OpenAI.";
      } else if (resposta.status === 429) {
        erro = "Limite da API atingido. Confira uso e créditos.";
      } else if (resposta.status === 404) {
        erro = "O modelo configurado não está disponível para a conta.";
      }

      return json(res, 502, { erro });
    }

    const texto = (resultado.output || [])
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content || [])
      .filter((item) => item.type === "output_text")
      .map((item) => item.text)
      .join("\n");

    if (!texto) {
      return json(res, 502, {
        erro: "A IA retornou uma resposta sem texto."
      });
    }

    return json(res, 200, { resposta: texto });
  } catch {
    return json(res, 502, {
      erro: "Falha de comunicação ou tempo de resposta excedido."
    });
  } finally {
    ocupado = false;
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (!adminUser || !adminPassword) {
    res.writeHead(503);
    return res.end("Configure as credenciais do painel no Render.");
  }

  if (!autorizado(req)) {
    const agora = Date.now();
    tentativasLogin = tentativasLogin.filter(
      (t) => agora - t < 60000
    );

    if (tentativasLogin.length >= 30) {
      res.writeHead(429, { "Retry-After": "60" });
      return res.end("Muitas tentativas. Aguarde um minuto.");
    }

    tentativasLogin.push(agora);
    res.setHeader(
      "WWW-Authenticate",
      'Basic realm="Versaniche Vendas", charset="UTF-8"'
    );
    res.writeHead(401);
    return res.end("Entre com seu usuário e senha.");
  }

  const rota = (req.url || "/").split("?")[0];

  try {
    if (
      req.method === "GET" &&
      ["/", "/painel"].includes(rota)
    ) {
      res.writeHead(200);
      return res.end(painel);
    }

    if (req.method === "GET" && rota === "/status") {
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8"
      });
      return res.end(bancoStatus);
    }

    if (req.method === "POST" && rota === "/api/jarvis") {
      return await conversar(req, res);
    }

    if (rota === "/api/mercadolivre/callback") {
      res.writeHead(503);
      return res.end("Integração ainda em configuração.");
    }

    res.writeHead(404);
    res.end("Página não encontrada.");
  } catch {
    if (!res.headersSent) {
      json(res, 500, { erro: "Erro interno do servidor." });
    } else {
      res.end();
    }
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Servidor iniciado na porta ${port}`);
  testarBanco();
});
