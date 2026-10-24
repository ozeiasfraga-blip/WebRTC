# Sala de Tela

Site próprio de **compartilhamento de tela com chat e voz**, feito para substituir o
compartilhamento do Discord. Roda no seu computador, sem conta, sem instalação de
programa para quem assiste: é só abrir o link no navegador.

- Compartilha **tela + áudio do sistema** (aba, janela ou tela inteira)
- **Chat** de texto com histórico da sessão e aviso de mensagens novas
- **Microfone** opcional (com cancelamento de eco)
- Salas por código, link de convite com um clique
- Tela cheia por tile, duplo clique para dar destaque a alguém
- Nada é gravado: vídeo e som vão **direto de navegador para navegador** (P2P)

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

## 5. Configurações (variáveis de ambiente)

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

## 6. Como funciona

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

## 7. Estrutura

```
server.js            servidor (arquivos estáticos, WebSocket, salas, chat, HTTPS local)
public/index.html    interface
public/styles.css    aparência
public/app.js        WebRTC, tela, microfone, chat, UI
scripts/gen-cert.js  regenera o certificado local (npm run cert)
iniciar.bat          atalho para Windows
certs/               certificado e chave gerados (não versionar)
```

## 8. Problemas comuns

| Sintoma | Causa provável / solução |
| --- | --- |
| “Não foi possível capturar a tela” | Página em `http://` fora do localhost → use `https://` |
| Botão de compartilhar não faz nada | Navegador antigo ou permissão de captura negada |
| Entrou, mas não vê nem ouve ninguém | Falha de NAT/firewall → configure TURN (item 4) |
| “A porta já está em uso” | Rode com outra porta: `$env:PORT="8092"; npm start` |
| Aviso de certificado em toda visita | Normal no certificado local; use um túnel HTTPS se incomodar |
| Vídeo travado/quadriculado | Baixe a **Qualidade** para “Econômica” ou feche outras abas pesadas |

## 9. Privacidade e limites

- Não há login, banco de dados nem gravação. As mensagens e a sessão somem quando a sala esvazia.
- Quem tiver o código/link entra na sala. Use códigos difíceis de adivinhar: o botão
  **Novo** sorteia 4 caracteres, o que serve para uso interno; para reuniões sensíveis,
  digite 6 ou mais caracteres.
- A conexão é criptografada ponta a ponta pelo WebRTC (DTLS-SRTP); o servidor não vê a mídia.
- O servidor só é alcançável por quem estiver na sua rede, a menos que você use um túnel
  ou abra portas — aí ele fica exposto à internet (mantenha o Node atualizado).
