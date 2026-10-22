# Agente de impressão (Windows + Epson TM-T20)

O agente é um serviço do Windows instalado no computador do balcão. Ele busca os pedidos no servidor pela internet e imprime as comandas. Ele **não abre portas**: só faz conexões de saída HTTPS. Também não precisa de IP fixo nem de configuração no roteador.

## Como funciona

1. O cliente fecha o pedido e o servidor cria um trabalho de impressão.
2. O agente, que mantém uma conexão de espera (long-poll), recebe o trabalho em cerca de 1 segundo.
3. O agente avisa o servidor que vai imprimir ("enviando") e grava isso no diário local. Só depois imprime.
4. Ele informa o resultado, e o painel mostra a situação de cada comanda:

| Situação no painel | Significado |
| --- | --- |
| Na fila | Aguardando o agente |
| Enviado à impressora | O Windows (USB) aceitou a comanda. Pela USB, a impressora não confirma fisicamente a saída do papel. |
| Impresso | Impressora de rede confirmou estado OK após receber |
| Falha na impressão | Nada foi impresso (sem papel, tampa aberta, desligada). O sistema tenta de novo sozinho: 5 s, 15 s, 30 s, 1 min, 2 min, 5 min… até 8 tentativas. |
| Resultado incerto | Caiu no meio do envio; não dá para saber se saiu. **Não reimprime sozinho.** Confira no balcão e escolha, no detalhe do pedido, "Saiu, marcar como impresso" ou "Não saiu, imprimir de novo". |

### Proteções contra comanda duplicada ou perdida

- Cada pedido tem uma única comanda original. Reimpressões são numeradas e saem com a faixa "REIMPRESSÃO Nº n".
- O diário local (`state.json`) sobrevive a queda de energia. Se o agente parar no meio, o trabalho vira "incerto", e não é impresso de novo às cegas.
- Se a internet cair depois da impressão, o resultado fica numa fila local e é enviado quando a conexão volta.
- Pedidos feitos com o computador desligado ficam na nuvem e imprimem quando o agente volta.
- Uma chave revogada no painel para de funcionar na hora.

## Antes de instalar

1. Ligue a TM-T20 e instale o driver da Epson (Epson Advanced Printer Driver), disponível no site da Epson para o modelo exato. Imprima a página de teste do Windows.
   - **USB:** anote o nome da impressora como aparece em *Configurações > Impressoras* (ex.: `EPSON TM-T20II Receipt`).
   - **Rede (modelos com Ethernet):** defina um IP fixo para a impressora (reserva no roteador). Para descobrir o IP atual, desligue a impressora, segure o botão FEED e ligue: sai a folha de status.
2. No painel, vá em **Configurações > Impressora**:
   - Escolha a conexão (USB ou rede) e preencha o nome no Windows ou o IP e a porta (9100).
   - Escolha a largura: 80 mm = 48 colunas (padrão da TM-T20), 42 colunas (fonte maior) ou 58 mm = 32 colunas.
   - Defina as vias por pedido e o rodapé da comanda.
   - Clique em **+ Credencial de agente**, dê um nome (ex.: "PC do caixa") e copie a chave (`rgd_...`): ela aparece uma única vez.

## Instalar

**Com o instalador** `RangassoAgentSetup-x.y.z.exe` (recomendado): execute-o e avance. O endereço e a chave podem ser informados no instalador ou deixados em branco. No fim, o **Monitor de Impressão** abre no navegador; se faltou configurar, ele mostra um passo a passo para colar o endereço e a chave. O serviço já fica rodando.

## Monitor de Impressão

Página local em `http://127.0.0.1:17800`, aberta pelo atalho **Monitor de Impressão Rangasso** (menu Iniciar e área de trabalho). Mostra:

- se o computador está conectado ao sistema e com qual nome de agente;
- o estado da impressora (pronta, sem papel, tampa aberta, desligada; pela USB a Epson não informa papel/tampa);
- as últimas comandas impressas por este computador e os avisos aguardando internet;
- o botão **Imprimir teste**, a configuração (endereço, chave, qual impressora usar) e o registro de atividade.

A página só abre no próprio computador (não fica acessível pela rede da loja) e nunca mostra a chave do agente. Fechar o navegador não para o agente.

**Com o pacote .zip:** extraia o pacote e, no PowerShell como Administrador, dentro da pasta, rode:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -ServerUrl https://SEU-DOMINIO -Token rgd_SUA_CHAVE
```

O serviço **Rangasso - Agente de Impressão** inicia com o Windows (início atrasado, depois do spooler). Se cair, ele é reiniciado sozinho após 10, 30 e 60 s.

> O computador do balcão precisa ficar ligado no horário de funcionamento. Desative a suspensão em *Opções de energia*.

## Testar

Pelo painel: **Configurações > Impressora > Imprimir teste**. O painel mostra o agente online, a versão e o estado da impressora.

No computador da loja (Prompt de Comando como administrador):

```bat
"C:\Program Files\RangassoAgent\rangasso-agent.cmd" test-connection
"C:\Program Files\RangassoAgent\rangasso-agent.cmd" list-printers
"C:\Program Files\RangassoAgent\rangasso-agent.cmd" test-print
"C:\Program Files\RangassoAgent\rangasso-agent.cmd" status
```

A comanda de teste traz uma linha de acentos (`ÁÉÍÓÚ ãõ ç`) e uma régua com a largura configurada. Se os acentos saírem trocados, veja "Problemas comuns".

## Onde ficam os arquivos

| O quê | Onde |
| --- | --- |
| Programa | `C:\Program Files\RangassoAgent` |
| Configuração (contém a chave) | `C:\ProgramData\RangassoAgent\config.json` (só administradores) |
| Logs do agente (14 dias) | `C:\ProgramData\RangassoAgent\logs` |
| Logs do serviço | `C:\ProgramData\RangassoAgent\service-logs` |
| Diário e fila local | `C:\ProgramData\RangassoAgent\state.json` |

Os logs não registram dados de clientes, apenas o número do pedido.

Por padrão (`"mode": "auto"`), a impressora é a definida no painel, e mudanças chegam ao agente em até ~30 s. Para fixar uma impressora no próprio computador, edite `printer` no `config.json` (`windows`, `network` ou `file`) e reinicie o serviço.

## Atualizar e desinstalar

- **Atualização automática (a partir da 1.4.0):** o agente pergunta ao site, 2 minutos depois de iniciar e a cada 6 horas, se há versão nova. O site publica o agente da mesma versão dele (vem junto no deploy). Se houver, o agente baixa o `agent.cjs`, confere o SHA-256, grava em `C:\ProgramData\RangassoAgent\update\` e reinicia o serviço (cerca de 10 s sem imprimir; a fila do servidor espera). Se a versão nova não conseguir se conectar em 3 partidas seguidas, é descartada e volta a valer a versão instalada. Só funciona com `https://` (ou localhost). Para desligar, defina a variável `RANGASSO_NO_AUTO_UPDATE=1` no serviço. A versão em uso aparece no Monitor e no painel (Configurações > Impressora).
- **Atualizar pelo instalador:** rode o instalador da versão nova por cima. A configuração e a fila local são mantidas; se o instalador for mais novo que a atualização baixada, vale o instalador.
- **Trocar a chave:** gere outra no painel, revogue a antiga e rode `install.ps1 -Token rgd_NOVA` (ou `rangasso-agent setup --token rgd_NOVA`) e reinicie o serviço.
- **Desinstalar:** use *Painel de Controle > Programas*, ou rode `uninstall.ps1` (com `-RemoveData` para apagar também a configuração e os logs).

## Problemas comuns

| Sintoma | Causa provável e solução |
| --- | --- |
| Painel mostra agente offline | Computador desligado/suspenso, sem internet ou serviço parado (`services.msc`). Veja os logs. |
| "Credencial recusada" no log | Chave revogada ou digitada errada. Gere outra no painel. |
| Falhou: "não encontrada" | Nome da impressora no painel diferente do Windows. Use `list-printers` e copie o nome exato. |
| Sai "?" ou letras erradas nos acentos | A tabela de caracteres foi alterada no utilitário da Epson. O agente envia `ESC t 3` (PC860, português) em toda comanda. Restaure o padrão de fábrica pelo *TM-T20 Utility*. |
| Corte não acontece | Modelo sem guilhotina ou corte desativado no utilitário. |
| Serviço não vê a impressora USB | O serviço roda como *Sistema Local* e precisa de impressora instalada para todo o computador, não só para o usuário. |
| Muitos "Resultado incerto" | Cabo USB/rede com mau contato ou impressora desligando sozinha. Verifique hardware e energia. |

## Gerar o instalador (desenvolvedor)

```bash
npm ci
npm -w apps/agent run build          # build/agent.cjs (arquivo único)
npm -w apps/agent run package:win    # dist/RangassoAgent-x.y.z/ e .zip (baixa Node.js e WinSW, confere SHA-256)
# no Windows, com Inno Setup 6:
iscc /DAppVersion=1.0.0 /DSourceDir=..\..\dist\RangassoAgent-1.0.0 apps\agent\windows\installer\RangassoAgent.iss
```

O CI (job `agent-windows`) faz tudo isso num Windows e roda o teste de fumaça: instala, confere o serviço, imprime pelo spooler real numa porta de arquivo, derruba o processo, confere o reinício e desinstala. O instalador e o zip ficam como artefato da execução por 14 dias.

O executável não é assinado digitalmente (code signing). O Windows SmartScreen pode avisar "editor desconhecido" na primeira execução. Para evitar isso, é preciso comprar um certificado de assinatura de código.
