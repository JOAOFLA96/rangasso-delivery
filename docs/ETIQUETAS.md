# Etiquetas de validade (cozinha)

Aba **Etiquetas** do painel (`/admin/etiquetas`). Etiqueta térmica **50 x 30 mm**, espaço de **4 mm** entre etiquetas.

## O que sai na etiqueta
Produto · tipo (Manipulado / Aberto / Descongelando / Amostra) · conservação (Resfriado ≤5°C, Congelado ≤-18°C, Ambiente) ·
data/hora de manipulação · **validade com dia da semana** · responsável · lote (`AAMMDD-NNN`, sequência do dia) ·
quantidade/peso, informação extra e observação do produto · nome da loja.

## Telas
- **Imprimir**: escolhe o produto, a validade é calculada pelo prazo cadastrado para a conservação (pode ser trocada à mão, ex.: embalagem vence antes). Produto avulso: digita nome e validade.
- **Vencimentos**: etiquetas ativas ordenadas pela validade, com contadores de vencidos e que vencem em 24 h. Baixa como **Usado** ou **Descartado** (descarte exige motivo e fica registrado como perda). Reimprimir usa o mesmo lote.
- **Produtos e prazos**: cadastro (gerente/dono) com prazo em horas ou dias por conservação. Os prazos são da loja (manual de boas práticas); o sistema não sugere prazos.
- **Ajustes de impressão**: por computador (fica no navegador): papel com espaço (gap) ou contínuo, espaço, margem e deslocamentos; imprime teste de alinhamento.

## Impressão
Pelo navegador (Chrome/Edge): cada etiqueta é uma página `@page 50mm x 30mm`. Funciona com qualquer impressora térmica de etiqueta com driver Windows.
No driver: papel 50 x 30 mm, tipo etiqueta com espaço (gap) de 4 mm. No diálogo: Margens **Nenhuma**, Escala **Padrão**, sem cabeçalhos/rodapés.
Sem diálogo: atalho do Chrome com `--kiosk-printing`. A Epson TM-T20 (cupom) não imprime essas etiquetas.

## Impressora de etiquetas direto (TSPL, recomendado)
Para impressoras térmicas de etiqueta com comandos **TSPL** (OIA-B381, Xprinter, Elgin, Argox e similares) ligadas por USB a um PC com o agente.
- Configure em **Etiquetas › Ajustes**: PC do agente, nome da impressora no Windows, tamanho (50 x 30), espaço (4 mm), velocidade (2 recomendado), densidade (10 a 12), deslocamentos e giro 180°.
- O agente envia `SIZE 50 mm,30 mm` + `GAP 4 mm,0 mm` + `SPEED`/`DENSITY` + o texto + `PRINT 1,N`, em RAW pelo spooler do Windows. A impressora usa o sensor de espaço a cada etiqueta, então não "anda" de uma para outra.
- O trabalho vai só para o agente escolhido (`print_jobs.target_device_id`); comandas continuam indo para qualquer agente.
- Texto sem acento (as fontes internas dos modelos genéricos não têm acento).
- Botão "Salvar e imprimir teste (3)" imprime 3 etiquetas com moldura para conferir alinhamento.

## Pela Epson TM-T20 do caixa (quebra-galho)
Na tela Imprimir, "Imprimir em: Epson do caixa (bobina)". O painel cria um trabalho `label` na fila do agente (o mesmo das comandas),
e o agente desenha a etiqueta em ESC/POS na bobina de 80 mm, com **um corte por etiqueta** (até 50 cópias). Reimprimir em Vencimentos usa o mesmo lote.
- Precisa do agente **1.6.0+** (atualiza sozinho). Agentes mais antigos não recebem etiquetas (continuam recebendo comandas).
- Não sai no formato 50 x 30: a TM-T20 não tem sensor de espaço. Use bobina comum (prender com fita) ou bobina adesiva contínua de 80 mm; adesivo desgasta a guilhotina.
- Etiquetas entram na fila junto com os pedidos: em horário de pico, prefira imprimir antes do serviço.

## Testado
- API: `apps/api/test/labels.test.ts` (permissões, cálculo da validade, lotes, validações, baixa).
- Navegador: `e2e/etiquetas.spec.ts` gera o PDF de impressão e confere 1 página por etiqueta em 50 x 30 mm.
- Agente: `apps/agent/test/receipt.test.ts` (conteúdo, largura 32/42/48, corte por cópia, acentos/grau em CP860); `apps/api/test/print.test.ts` (fila só para agente 1.6.0+).
- TSPL: `apps/agent/test/tspl.test.ts` (comandos, coordenadas dentro de 400x240 pontos, limites, envio para a impressora indicada) e `apps/api/test/print.test.ts` (só o agente escolhido recebe).
- **Não testado em impressora física** (nem de etiqueta, nem a etiqueta na TM-T20).
