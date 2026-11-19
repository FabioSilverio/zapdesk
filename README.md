# Zapdesk

Cliente de WhatsApp **e Telegram** compacto para Windows (Electron + React + [Baileys](https://github.com/WhiskeySockets/Baileys) para o WhatsApp Web e [GramJS](https://github.com/gram-js/gramjs) para o Telegram).

## Rodar

```bash
npm install
npm run dev        # desenvolvimento com hot reload
npm run dist       # gera release/Zapdesk Setup <versão>.exe e release/Zapdesk-portable.exe
npm run release -- "nota 1|nota 2"   # sobe a versão, empacota e publica a atualização (o app mostra o botão verde)
```

## O que tem

- Login por QR code ou código de pareamento (número de telefone)
- Histórico sincronizado do celular, salvo localmente (abre instantâneo); rolar pra cima pede mensagens mais antigas ao celular
- Mensagens em tempo real pelo websocket do WhatsApp Web, ticks de entrega/leitura, "digitando…"
- Emojis (seletor em pt-BR), reações (atalhos rápidos + qualquer emoji), responder, editar/apagar recebidos
- Figurinhas favoritas importadas da conta (sync do app-state) + favoritar qualquer figurinha recebida
- Fixar conversas (grade no topo com atalhos Ctrl+1…9), seções personalizadas, arquivar, silenciar
- Notificações nativas do Windows, badge na barra de tarefas, bandeja do sistema
- Bloqueio automático com PIN de 4 ou 6 dígitos depois de X minutos inativo (padrão 10), ao bloquear o Windows e ao suspender
- Aparência: temas Verde escuro (padrão), Grafite, Catppuccin Mocha, Catppuccin Latte, Claro; cor de destaque; densidade; bolhas ou lista; fixados em grade ou lista; cantos; tamanho do texto; largura da barra lateral
- Fonte à escolha na primeira abertura: Segoe UI (Windows), Inter (inclusa), SF Pro (se instalada) ou qualquer arquivo .ttf/.otf

- Várias contas de WhatsApp ao mesmo tempo (todas conectadas e notificando); troca pelo nome no rodapé
- Formatação: barra ao selecionar texto, Ctrl+B/I/E, Ctrl+Shift+X/M, citação `>`, listas `-` e `1.`, prévia ao digitar
- Links mostrados pelo título do site + cartão de prévia; prévia anexada nos links que você envia
- Ferramentas: anti-apagar, histórico de edição, modo fantasma, agendar mensagem, lembretes, respostas rápidas `/`, modo privacidade, exportar conversa, bloquear contato, apagar conversa (sincroniza com o celular)

- **Telegram**: login por QR (com senha de 2 etapas), pastas iguais às da conta, canais, reações, vídeos que tocam enquanto baixam (4 partes em paralelo)
- **Transcrição de áudios** 100% local (whisper.cpp + modelo small, baixado uma vez): automática ao receber, texto na lista de conversas, áudios longos aparecem aos poucos
- **Atualização com um clique**: botão verde no rodapé quando há versão nova
- Prévia animada ao passar o mouse numa conversa; prévia antes de enviar arquivos (colar, arrastar ou escolher)
- Vídeos com o primeiro quadro nítido; mídias da tela baixam primeiro
- Mensagens editadas (inclusive o formato criptografado novo do WhatsApp) com etiqueta ✎ e texto original
- Lidas no celular ficam lidas no app; ✓/✓✓/azul também em grupos
- Liquid Glass (acrílico do Windows 11) e atalhos (Ctrl+/ mostra todos)

## Robustez

- Erros ficam em `%APPDATA%\zapdesk\zapdesk.log` em vez de derrubar o app
- Janela travada (8 s) ou página que caiu é recarregada sozinha; mensagem malformada vira um aviso só nela
- Arquivos gravados com cópia `.bak` (queda de energia não corrompe); gravação em lotes pra não congelar durante o sync
- Reconexão com backoff + vigia que reinicia conexão presa em "conectando" por 90 s

## Atalhos

Ctrl+1…9 abre conversas · Ctrl+K busca · Alt+↑/↓ navega · Ctrl+L bloqueia · Ctrl+, configurações · Enter envia · Shift+Enter quebra linha

## Dados

Configurações e PIN em `%APPDATA%\zapdesk\app.json`, lista de contas em `accounts.json`. A primeira conta usa `data\`, as outras `accounts\<id>\` (cada uma com `auth\`, `msgs\`, `media\`).

## Dev

`ZAP_DEMO=1` abre com conversas falsas (sem login) para testar a interface.

As fontes SF Pro da Apple não vêm no repositório (licença). Se você tiver os arquivos, coloque `sf-pro-display-400.otf`, `-500`, `-700`, `-300-italic` e `-600-italic` em `src/renderer/src/assets/fonts/` e elas entram no build.
