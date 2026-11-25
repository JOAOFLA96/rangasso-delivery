# Pedidos do 99Food

Os pedidos feitos no app do 99Food entram na aba **Pedidos** do painel (etiqueta amarela "99Food nº X"),
saem na impressora como os do cardápio (comanda com "99FOOD Nº X" no topo) e são **aceitos automaticamente**
no 99 assim que chegam. Usa a Plataforma Aberta do 99Food ("99Food Protocol").

## Passo a passo para ligar

1. **Pedir a integração ao 99Food.** No portal https://developer-food.99app.com, preencha o formulário
   "Preencha seus dados" (fim da página inicial) ou fale com o gerente de contas. O 99 envia um NDA
   (DocuSign) e libera a conta de desenvolvedor.
2. **Conta e Qualificação.** Em "Cadastrar-se", crie a conta e preencha a Qualificação com os dados da
   empresa (iguais aos do NDA). O 99 analisa e aprova.
3. **App de teste.** Em "Gerenciamento de aplicativo", crie o app `BR_T_Rangasso` e uma loja de teste.
   No campo **endereço de callback** coloque: `https://SEU-SITE/api/integrations/99food/webhook`
   (o endereço exato aparece em Configurações › 99Food no painel).
4. **Credenciais no servidor.** No Render › Environment, crie `FOOD99_APP_ID` e `FOOD99_APP_SECRET`
   com os valores do app e faça um novo deploy. Nunca mande essas credenciais por chat.
5. **Ligar a loja.** Em Configurações › 99Food, clique em "Gerar link de autorização" e abra o link com
   o usuário **SuperAdmin** da loja no 99Food. A loja aparece em "Lojas ligadas" com "Token válido".
6. **Testar** com o simulador (Sandbox) do portal e com pedidos de teste da conta de cliente que o 99 fornece.
7. **Produção.** Com os testes ok, crie o app `BR_P_Rangasso`, troque as duas variáveis pelas do app de
   produção, faça deploy e ligue a loja de verdade (passo 5).

## Como funciona

| Momento | O que o sistema faz |
| --- | --- |
| Pedido novo no 99 | Grava o pedido, põe na fila de impressão e aceita no 99 (prazo do 99: 5 minutos) |
| Aceite automático falha | Pedido fica em "Recebido" com aviso no histórico; o botão **Confirmar pedido** tenta de novo |
| Painel: Saiu para entrega | Avisa o 99 que está pronto e, se a entrega é da loja, que saiu (o entregador vai como a loja: nome e telefone de Configurações › Dados da loja) |
| Painel: Concluir | Entrega da loja: avisa o 99 que foi entregue |
| Painel: Cancelar | Cancela no 99 com o motivo digitado. Se o 99 recusar, nada muda no painel |
| Cancelado/concluído no 99 | O painel acompanha sozinho |
| Cliente pede cancelamento/reembolso | Aparece no histórico do pedido; responder pelo app **99Food Loja** |

Desligar o aceite automático: variável `FOOD99_AUTO_CONFIRM=false` (aí é preciso confirmar cada pedido em até 5 minutos).

## Limites desta versão

- O cardápio não é enviado ao 99: produtos e preços continuam sendo mantidos no 99Food Loja.
- Pedidos de entrega feita pelo 99 chegam e imprimem; a entrega fica com o 99.
- Respostas a pedidos de cancelamento/reembolso do cliente são dadas no app 99Food Loja.
- Ainda não foi testada com o 99 de verdade: depende da aprovação do cadastro. Os testes automáticos
  simulam o 99 com o formato da documentação oficial.
