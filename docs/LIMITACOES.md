# Limitações conhecidas e pendências

## Limitações técnicas atuais

1. **USB não confirma impressão física.** Pelo spooler do Windows, o sistema sabe que a comanda foi aceita ("Enviado à impressora"), não que o papel saiu. Com a TM-T20 de rede, há confirmação de estado ("Impresso").
2. **Estados de "sem papel/tampa aberta" via USB** dependem do driver Epson APD informar ao Windows. Com o driver genérico, isso pode não aparecer.
3. **Pagamento é na entrega** (dinheiro, Pix na entrega/maquininha, cartão na entrega). Ainda não há Pix com QR Code automático nem pagamento online. Isso exige contrato com um provedor de pagamento (PSP).
4. **Sem cupons de desconto.** As promoções são por preço promocional no produto.
5. **Aviso sonoro do painel** exige um toque em "Ativar som" após abrir a página (regra dos navegadores).
6. **Logo enviada em baixa resolução** (225 px). Para ficar nítida em telas grandes, envie a logo em PNG/SVG de pelo menos 1000 px.
7. **Instalador não assinado digitalmente.** O Windows SmartScreen pode alertar na primeira execução.
8. **Uma loja por instalação.** O banco já tem `store_id` em todas as tabelas, mas o painel administra uma única loja.
9. **Fila antiga imprime tudo de uma vez.** Se o agente ficar dias desligado com pedidos pendentes, ao voltar ele imprime todos. Em operação normal isso não acontece. Se incomodar, dá para criar uma regra de "não imprimir automaticamente pedidos com mais de X horas".
10. **Tempo real do painel** usa SSE. Proxies corporativos muito restritivos podem atrasar os avisos; nesse caso o painel atualiza ao reconectar.

## O que depende de você para ir ao ar

| Pendência | Para quê |
| --- | --- |
| Modelo exato da Epson (TM-T20, T20II, T20III, T20X) e conexão (USB ou rede) | Configurar a impressora e o roteiro de homologação |
| Servidor (VPS) e domínio | Publicar ([IMPLANTACAO.md](IMPLANTACAO.md)) |
| Cardápio real: produtos, preços, fotos, adicionais | Cadastrar no painel |
| Bairros atendidos, taxas, pedido mínimo, tempo de entrega | Cadastrar no painel |
| Horários, folgas e feriados | Cadastrar no painel |
| Dados da loja e contato de privacidade (LGPD) | Página de privacidade e rodapé |
| Decisão sobre Pix: na entrega ou QR Code automático | Se automático, escolher o PSP (exige contrato e chaves de API) |
| Prazo de retenção de dados de clientes | Rotina de anonimização (LGPD) |
