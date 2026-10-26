# Sala de Tela

Site próprio de **compartilhamento de tela com chat e voz**, feito para substituir o
compartilhamento do Discord. Roda no seu computador, sem conta, sem instalação de
programa para quem assiste: é só abrir o link no navegador.

- Compartilha **tela + áudio do sistema** (aba, janela ou tela inteira)
- **Chat** de texto com histórico da sessão e aviso de mensagens novas
- **Microfone** opcional (com cancelamento de eco)
- **Suporte remoto**: o técnico vê a tela e, com autorização, controla mouse e teclado
- Modo **Compatível** para PCs antigos que capturam tela preta
- Salas por código, link de convite com um clique
- Tela cheia por tile, duplo clique para dar destaque a alguém
- Nada é gravado: vídeo e som vão **direto de navegador para navegador** (P2P)

**No ar em:** https://survivorsstrugglepve.com.br/sala/

---

## 1. Como rodar (Windows)

Forma mais fácil: clique duas vezes em **`iniciar.bat`**.
Ele instala as dependências na primeira vez e abre `http://localhost:8090`.

Pelo terminal:

```powershell
cd "D:\Acesso remoto"
npm install
npm start
```

O terminal mostra os endereços disponíveis:

```
[sala] http  em http://localhost:8090
[sala]       em http://192.168.125.15:8090
[sala] https em https://localhost:8443
[sala]       em https://192.168.125.15:8443
```

Deixe a janela aberta enquanto estiver usando. `Ctrl+C` encerra.

## 2. Como usar

1. Digite seu nome e um **código de sala** (ex.: `EQUIPE`) — quem for entrar junto
   precisa usar o **mesmo código**.
2. Clique em **Entrar na sala**.
3. Clique em **Compartilhar tela** e escolha o que compartilhar.
   Marque **“Compartilhar áudio”** na janela do navegador para levar o som junto.
4. Clique em **Copiar convite** (ícone ao lado do código) e mande o link para a pessoa.
5. Abra o **Chat** no botão do meio para conversar por texto.

Atalhos: `Esc` sai do destaque/tela cheia. `Enter` envia a mensagem, `Shift+Enter` quebra linha.

### 2.1 Suporte remoto (ver e controlar)

O modo suporte é para quando alguém precisa **ver a tela e mexer no mouse/teclado** de
outro PC Windows. O vídeo continua indo de navegador para navegador; os comandos de
mouse/teclado vão por um agente local, e só depois que o dono do PC autoriza.

**No PC atendido (cliente):**

1. Entre na sala e clique em **Compartilhar tela** (prefira **Tela inteira**).
2. Clique em **Suporte** no rodapé.
3. Clique em **Gerar código**. Aparece um código de 6 caracteres, válido por 20 minutos.
4. Clique em **Baixar agente** e abra o arquivo `agente-suporte.bat`.
   - Se o Windows avisar que o arquivo é desconhecido: **Mais informações** →
     **Executar assim mesmo**.
   - Uma janela preta abre e mostra **CONECTADO**. Deixe essa janela aberta durante o
     atendimento; fechá-la encerra o agente na hora.
5. Quando aparecer **Pedido de controle**, clique em **Permitir**.
6. Para encerrar, clique em **Parar controle** na faixa azul ou feche a janela do agente.

**No PC do técnico:**

1. Abra o link com `?tecnico=1` (ou marque **Sou técnico** no lobby), por exemplo:
   `https://survivorsstrugglepve.com.br/sala/?sala=CODIGO&tecnico=1`.
2. Entre na mesma sala e aguarde a pessoa compartilhar a tela.
3. Quando o agente estiver conectado, clique em **Pedir controle**.
4. Depois que o cliente permitir, o mouse e o teclado passam a valer no PC dele.
   - **Teclado** liga/desliga o envio do seu teclado.
   - **Colar** envia um texto pronto (útil para senhas, acentos e atalhos complicados).
   - **Soltar controle** encerra.
5. O cliente também pode encerrar a qualquer momento em **Parar controle**.

**Segurança e limites:**

- O agente **não instala nada** e roda com o usuário logado, sem privilégios de
  administrador. Ele só existe enquanto a janela preta estiver aberta.
- Cada código é vinculado ao cliente que o gerou. Em uma sala com várias pessoas, o
  técnico só controla o PC de quem autorizou — não o de outro participante.
- A autorização fica só na memória do servidor e é revogada quando o cliente clica em
  **Parar controle**, quando o agente desconecta ou quando a pessoa sai da sala.
- O código vale por 20 minutos. Se expirar, gere outro e abra o agente de novo.
- Por ser um executável `.bat`, antivírus e o SmartScreen podem reclamar. Isso é
  esperado nesse tipo de acesso remoto; só rode o arquivo se você pediu suporte a
  alguém de confiança.
- O agente é **somente para Windows** (usa a API de teclado/mouse do Windows).

### 2.2 Tela preta ao compartilhar

Se a prévia local ou o vídeo do outro lado ficar preto (mas o chat/áudio funcionar),
tente nesta ordem:

1. **Use o modo compatível**: em **Qualidade**, escolha **Compatível (PC antigo)**.
   Também aparece um aviso no topo da tela quando o site detecta captura preta; clique
   em **Usar modo compatível**. Isso reduz a resolução/fps/bitrate e reabre a captura.
2. **Compartilhe a Tela inteira**, não uma janela específica. Janelas com proteção de
   conteúdo (DRM) ou alguns aplicativos com aceleração própria saem pretas.
3. **Desligue a aceleração de hardware** do navegador:
   - Chrome: **Configurações → Sistema → Usar aceleração de hardware quando disponível**
     (desmarque).
   - Edge: **Configurações → Sistema e desempenho → Usar aceleração de hardware quando
     disponível** (desmarque).
   - Feche **todas** as janelas do navegador e abra de novo.
4. **Abra o navegador em modo compatível**: no aviso de tela preta, clique em
   **Como resolver** → **abra o navegador em modo compatível**. Isso baixa
   `abrir-navegador-compat.bat`, que abre o Chrome/Edge com um perfil separado e sem
   aceleração de hardware. É o caminho mais garantido em PCs antigos com vídeo integrado.
5. **Atualize o driver de vídeo** pelo Windows Update ou pelo site do fabricante, e
   mantenha o Chrome/Edge atualizado.
6. Se estiver acessando por **RDP/AnyDesk**, mantenha a janela aberta e não minimize
   durante o compartilhamento.
7. Se continuar, abra **Suporte → Copiar diagnóstico** e mande o texto para o técnico.
   Ele inclui navegador, sistema, configurações da captura, luminância média e
   estatísticas da conexão.

O site também avisa automaticamente quando detecta captura preta (no PC que compartilha)
e quando recebe uma tela preta do outro lado (no PC que assiste).

## 3. Acessar de outro computador ou celular

Na mesma rede (Wi-Fi/cabo), use o endereço **HTTPS** da máquina que está rodando:

```
https://192.168.125.15:8443        (troque pelo IP que aparece no terminal)
```

O navegador vai avisar que o certificado não é confiável — isso é normal, é um
certificado local gerado na primeira execução:

- **Chrome/Edge:** *Avançado* → *Continuar para 192.168.x.x (não seguro)*
- **Firefox:** *Avançado* → *Aceitar o risco e continuar*

> Por que HTTPS? O navegador só permite capturar tela em páginas seguras.
> `http://localhost` é uma exceção; qualquer outro endereço precisa de `https://`.
> Se abrir `http://192.168.x.x:8090`, o site avisa e o botão de compartilhar não funciona.
> Se o IP do computador mudar, rode `npm run cert` para regerar o certificado com o novo IP.

## 4. Acessar de fora da sua rede

Três caminhos, do mais simples ao mais trabalhoso:

**a) Túnel (recomendado)** — não precisa abrir porta no roteador:

```powershell
# Cloudflare Tunnel (precisa de conta gratuita)
cloudflared tunnel --url http://localhost:8090

# ou ngrok
ngrok http 8090
```

O túnel já entrega um endereço `https://...` válido, então o compartilhamento de tela
funciona sem aviso de certificado.

**b) Abrir porta no roteador** — redirecione a porta `8443` e use
`https://seu-ip-publico:8443`.

**c) VPS/servidor** — copie a pasta, `npm install` e `npm start`. O certificado local
será criado; para um domínio de verdade, use um proxy reverso (Caddy/Nginx) com
certificado Let's Encrypt na frente.

### TURN (quando a conexão não fecha)

Em redes empresariais restritivas (ou 4G com CGNAT), o P2P pode falhar. Aí é preciso
um servidor TURN (ex.: [coturn](https://github.com/coturn/coturn)). Configure por variáveis:

```powershell
$env:TURN_URL="turn:meu-turn.exemplo.com:3478"
$env:TURN_USER="usuario"
$env:TURN_PASS="senha"
npm start
```

## 5. Publicar no seu domínio (XAMPP + Apache)

Nesta máquina o site já está no ar em **https://survivorsstrugglepve.com.br/sala/**
usando o Apache do XAMPP e o certificado Let's Encrypt que já existia.

Como está montado:

| Peça | Papel |
| --- | --- |
| `C:\xampp\htdocs\sala` | interface (HTML/CSS/JS) servida pelo Apache |
| Node em `127.0.0.1:8090` | sinalização WebRTC + chat + agente de suporte |
| `conf/extra/httpd-sala.conf` | encaminha `/sala/ws`, `/sala/agente`, `/sala/agente.bat`, `/sala/navegador.bat` e `/sala/config.json` para o Node |
| `mod_proxy_wstunnel` | habilitado no `httpd.conf` (necessário para WebSocket) |

Depois de alterar o código, publique com:

```powershell
cd "D:\Acesso remoto"
.\publicar.bat
```

Ele copia `public\` para `htdocs\sala` e sobe o Node se estiver parado.

O Node também sobe junto com o Windows: o atalho **Sala de Tela** na pasta
Iniciar (`Win+R` → `shell:startup`) executa `servidor-oculto.vbs`, sem janela.
Se quiser que não suba mais sozinho, apague esse atalho.

Detalhes que importam:

- Se mudar a porta do Node, ajuste as linhas `ProxyPass` em `httpd-sala.conf`.
- O Apache precisa de `mod_proxy` + `mod_proxy_wstunnel` (já ativados).
- Se a página abrir mas o chat/compartilhar ficar em "Conectando…", o Node está
  parado: rode `publicar.bat` e recarregue.
- As rotas `/sala/agente.bat` e `/sala/navegador.bat` são geradas pelo Node. A rota
  `/sala/agente` é o WebSocket do agente. Se você mover o site para outra pasta,
  ajuste também o parâmetro `base` usado na página (ele é calculado sozinho).
- O `agente/agente.ps1` é lido pelo Node a cada download, então alterações nele não
  exigem copiar `public\`; basta baixar o agente de novo.
- Como o certificado é o do seu domínio, não aparece aviso e o compartilhamento de
  tela funciona sem nenhum clique extra. O agente também usa `wss://` nesse domínio;
  se o certificado estiver vencido, o agente não conecta.

## 6. Configurações (variáveis de ambiente)

| Variável      | Padrão | Para quê                                          |
| ------------- | ------ | ------------------------------------------------- |
| `PORT`        | `8090` | Porta HTTP (localhost)                            |
| `HTTPS_PORT`  | `8443` | Porta HTTPS (rede / celular)                      |
| `MAX_PEERS`   | `8`    | Máximo de pessoas por sala                        |
| `NO_HTTPS`    | —      | `1` desliga o HTTPS local                         |
| `TURN_URL`    | —      | URL do TURN, separadas por vírgula se houver mais |
| `TURN_USER`   | —      | Usuário do TURN                                   |
| `TURN_PASS`   | —      | Senha do TURN                                     |

Exemplo: `$env:PORT="9000"; npm start`

## 7. Como funciona

```
navegador A  ⇄  servidor Node (sinalização WS + chat)  ⇄  navegador B
      └────────────── vídeo/áudio P2P (WebRTC) ─────────────┘
```

- O servidor só apresenta as pessoas, troca os dados de conexão (SDP/ICE) e repassa o chat.
  A tela e a voz **não passam pelo servidor**.
- Cada participante abre uma conexão direta com cada outro (malha). Com 3–4 pessoas
  funciona muito bem; com 6+ o upload de quem compartilha vira o gargalo.
- Cada conexão tem 2 canais fixos (1 vídeo + 1 áudio). Microfone e áudio da tela são
  misturados no navegador antes de enviar, e ao começar/parar de compartilhar apenas a
  trilha é trocada — sem renegociar a conexão.
- O chat fica só na memória do servidor: nada é salvo em disco. Quem entra depois não
  vê as mensagens anteriores (como um chat de sala ao vivo).

## 8. Estrutura

```
server.js            servidor (arquivos estáticos, WebSocket, salas, chat, HTTPS local)
public/index.html    interface
public/styles.css    aparência
public/app.js        WebRTC, tela, microfone, chat, UI e suporte remoto
agente/agente.ps1    agente PowerShell que aplica mouse/teclado no PC atendido
scripts/gen-cert.js  regenera o certificado local (npm run cert)
deploy/httpd-sala.conf  cópia versionada da configuração do Apache
iniciar.bat          atalho para rodar localmente no Windows
publicar.bat         copia a interface para htdocs\sala e sobe o Node
servidor-oculto.vbs  inicia o Node sem janela (usado no Inicializar do Windows)
certs/               certificado e chave gerados (não versionar)
```

## 9. Problemas comuns

| Sintoma | Causa provável / solução |
| --- | --- |
| “Não foi possível capturar a tela” | Página em `http://` fora do localhost → use `https://` |
| Botão de compartilhar não faz nada | Navegador antigo ou permissão de captura negada |
| Entrou, mas não vê nem ouve ninguém | Falha de NAT/firewall → configure TURN (item 4) |
| “A porta já está em uso” | Rode com outra porta: `$env:PORT="8092"; npm start` |
| Aviso de certificado em toda visita | Normal no certificado local; use um túnel HTTPS se incomodar |
| Vídeo travado/quadriculado | Baixe a **Qualidade** para “Econômica” ou feche outras abas pesadas |
| Tela preta ao compartilhar | Use **Compatível**, compartilhe a tela inteira, desligue a aceleração de hardware ou abra o navegador pelo `.bat` de compatibilidade (item 2.2) |
| Tela preta só em um PC antigo | Driver de vídeo/aceleração: atualize o driver e use o navegador em modo compatível |
| “Pedir controle” desabilitado ou agente off | O cliente ainda não abriu o `agente-suporte.bat` ou ele não está compartilhando a tela |
| Agente não conecta | Código expirado (20 min), data/hora do Windows errada, certificado vencido ou Node parado |
| Windows bloqueia o `agente-suporte.bat` | **Mais informações** → **Executar assim mesmo**; é um script local, não um instalador |
| Página abre, mas o chat fica em “Conectando…” | O Node está parado: rode `publicar.bat` (ou `npm start`) |

## 10. Privacidade e limites

- Não há login, banco de dados nem gravação. As mensagens e a sessão somem quando a sala esvazia.
- Quem tiver o código/link entra na sala. Use códigos difíceis de adivinhar: o botão
  **Novo** sorteia 4 caracteres, o que serve para uso interno; para reuniões sensíveis,
  digite 6 ou mais caracteres.
- A conexão é criptografada ponta a ponta pelo WebRTC (DTLS-SRTP); o servidor não vê a mídia.
- **O suporte remoto dá controle real do mouse e teclado.** Só permita depois de conferir
  quem está pedindo. O cliente pode encerrar em **Parar controle** ou fechando a janela do
  agente. O agente não é instalado, não fica no Inicializar do Windows e roda com os
  privilégios do usuário logado.
- O código do agente e as autorizações ficam na memória do Node e expiram sozinhos; nada
  é gravado em disco.
- O servidor só é alcançável por quem estiver na sua rede, a menos que você use um túnel
  ou abra portas — aí ele fica exposto à internet (mantenha o Node atualizado e use
  HTTPS).
