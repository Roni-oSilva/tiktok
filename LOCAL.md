# Rodando no seu PC (para conectar ao seu TikTok)

A conexão com a live precisa sair do **seu computador**: o motor e a cena rodam aí, e você captura a cena no TikTok LIVE Studio ou no OBS.

## 1. Instalar (uma vez)
1. Instale o **Node.js 20 ou 22 (LTS)**: https://nodejs.org
2. Baixe o projeto: `git clone https://github.com/Roni-oSilva/tiktok` e entre na pasta
   `git checkout claude/zen-gauss-yr96ia`
3. `npm install`

## 2. Testar sem live (simulação)
`npm run demo` → abra **http://127.0.0.1:8787/** no navegador. A faixa vermelha “SIMULAÇÃO — EVENTOS FICTÍCIOS” confirma que nada é real. Clique na página uma vez para liberar o som.

## 3. Conectar ao seu TikTok
1. Copie `.env.example` para `.env` e coloque seu usuário: `TIKTOK_USERNAME=@seuusuario`
2. **Inicie a live no TikTok primeiro** (a biblioteca só conecta em live ativa).
3. `npm run live` — o terminal mostra `Cena: http://127.0.0.1:8787/` e o estado da conexão (`connected`, ou tentativas de reconexão).
4. Faça um teste: no chat digite `13` ou `22`, depois envie uma Rosa. Um eleitor deve caminhar até a cabine e o placar sobe.

> A conexão real **ainda não foi validada** por mim. Na primeira live de teste, confira se nomes, presentes e curtidas chegam certos; se algo divergir, me envie o erro/log do terminal.

## 4. Colocar a cena na live
- **OBS / TikTok LIVE Studio:** adicione uma *Fonte de navegador* com a URL `http://127.0.0.1:8787/`, largura **1080**, altura **1920** (vertical). Marque “controlar áudio via OBS” para o som sair na live.
- Sem fonte de navegador: abra a URL no Chrome e capture a janela.

## 5. Música de fundo e som da urna
- O **som da urna** (bip das teclas e bip longo do “FIM”) é gerado pela própria cena.
- **Música:** coloque seu arquivo em `public/assets/music.mp3` (ou `.ogg`/`.m4a`). Sem arquivo, toca uma melodia provisória sintetizada.
- Use só música que você tenha direito de usar; o TikTok pode silenciar ou derrubar lives com música protegida.
- Parâmetros na URL: `?musicvol=0.2` (volume da música), `?vol=0.7` (efeitos), `?music=0` (sem música), `?mute=1` (mudo), `?speed=1.5` (velocidade).

## 6. Regras do jogo (editáveis em `src/preset.ts` e `src/config.ts`)
Digite **13** (Lula) ou **22** (Flávio) — ou `!votar 13` — para escolher. Cada **Rosa = 1 voto** no candidato escolhido; sem escolha, o presente é ignorado (nunca vai para um candidato sorteado). A cada **1.000 curtidas** nasce um eleitor (hoje ele passa pela urna **sem votar em ninguém**; dá para mudar a política). Eleitores entram um de cada vez; com fila grande, a cena agrupa, sem perder votos.

## 7. Aviso
É um jogo de entretenimento, com aviso fixo na tela. Por envolver candidatos reais e presentes pagos, confira as regras do TikTok para conteúdo político e a legislação eleitoral vigente antes de ir ao ar.

## Continuar comigo no seu PC
Instale o Claude Code no PC, abra um terminal na pasta do projeto e rode `claude`. Eu continuo daí, já com acesso ao seu TikTok local.
