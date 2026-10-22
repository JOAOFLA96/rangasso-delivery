# Testes: o que foi verificado e o que falta

Este documento separa o que foi **executado** (com resultado) do que foi **simulado** e do que **ainda depende de teste físico**. Os resultados abaixo são da data de 21/10/2026, no ambiente de desenvolvimento (Linux) e no CI do GitHub.

## Automatizados (rodam a cada PR no CI)

| Conjunto | Comando | Resultado | O que cobre |
| --- | --- | --- | --- |
| API | `npm -w apps/api test` | 78/78 passando | Cálculo no servidor, idempotência, estoque, bairros/taxas, bairro novo pelo CEP (taxa a combinar), taxa por km (faixas, fora do raio, mapa fora do ar, cache), horário (inclusive madrugada), login, bloqueio por tentativas, papéis, CSRF, fila de impressão, retentativas, leases, revogação, auditoria |
| Agente | `npm -w apps/agent test` | 47/47 passando (Linux) | Comanda ESC/POS (larguras, acentos CP860, vias, corte), diário local, anti-duplicação, sem papel, tampa aberta, queda de conexão, impressora sem status |
| Integração | `npm -w apps/agent run test:integration` | 10/10 passando | API real + PostgreSQL + agente compilado + impressora TCP simulada (cenários abaixo) |
| Navegador | `npx playwright test` (com a API no ar) | 44/44 passando | Cardápio (inclusive CEP preenchendo rua e bairro e taxa por km) e painel em 4 perfis: Android (Pixel 7), iPhone 13 (emulado no Chromium), tablet e desktop |
| Windows | job `agent-windows` do CI | ver resultado no PR | Testes do agente no Windows, instalador Inno Setup, instalação silenciosa, serviço, impressão pelo spooler real (porta em arquivo), reinício automático, atualização automática (servidor falso oferece versão nova; serviço reinicia na versão baixada), desinstalação |
| Implantação | job `deploy-check` do CI | ver resultado no PR | Imagem Docker, Compose, Caddyfile, container sobe/migra/serve, criação do primeiro admin |

### Cenários de integração (pedido → painel → agente → impressora simulada)

1. Pedido feito com o agente desligado imprime quando o agente liga.
2. Pedido novo chega na impressora em menos de 5 s.
3. Clique duplo no "Enviar pedido" gera um pedido e uma comanda.
4. Reimpressão sai marcada "REIMPRESSÃO Nº 1".
5. Sem papel: falha com motivo; quando o papel volta, imprime sozinha uma vez.
6. Agente derrubado (`kill -9`) e religado: nada duplicado.
7. Servidor reiniciado: o agente reconecta sozinho.
8. Agente morre depois de enviar e antes de confirmar: "Resultado incerto", sem reimpressão automática; a loja decide.
9. Impressora trocada no painel passa a valer no agente sem mexer no computador.
10. Chave revogada: o agente para de receber trabalhos.

## Verificações manuais feitas

- A imagem Docker de produção foi construída e executada localmente. Ela migrou o banco, serviu `/cardapio` e `/admin`, aceitou login do admin criado por `create-admin` e o agente imprimiu teste (modo arquivo) contra ela.
- O pacote Windows (`package:win`) foi gerado. O Node.js e o WinSW foram baixados com SHA-256 conferido.
- As capturas de tela do cardápio e do painel (celular e desktop) foram conferidas visualmente.

## Ainda NÃO testado (depende de você)

| Item | Por quê | Como testar |
| --- | --- | --- |
| Impressão física na Epson TM-T20 | Não há impressora neste ambiente | Roteiro abaixo |
| Driver Epson APD informando "sem papel/offline" pelo Windows | Depende do driver instalado | Roteiro abaixo, itens 6 e 7 |
| Safari real no iPhone | O teste usa Chromium com tela e user agent de iPhone | Abrir o cardápio num iPhone e fazer um pedido |
| HTTPS e domínio reais | Ainda sem servidor e domínio | Seguir [IMPLANTACAO.md](IMPLANTACAO.md) |
| Carga (muitos pedidos simultâneos) | Fora do escopo desta fase | Teste com ferramenta de carga em homologação, se necessário |

## Roteiro de homologação no balcão (30 a 40 minutos)

Faça com a loja fechada e marque cada item:

1. [ ] Instalar o agente e ver "online" no painel em **Configurações > Impressora**.
2. [ ] "Imprimir teste": a comanda sai com acentos corretos, régua na largura certa e corte.
3. [ ] Fazer um pedido real pelo celular (4G, fora do Wi-Fi da loja): ele aparece no painel com aviso sonoro e a comanda sai em poucos segundos.
4. [ ] Conferir na comanda: número, cliente, telefone, endereço, referência, itens, adicionais, observações, totais, forma de pagamento e troco.
5. [ ] Reimprimir pelo painel: sai com "REIMPRESSÃO Nº 1".
6. [ ] Abrir a tampa da impressora e fazer um pedido: o painel mostra falha ou "Enviado". Fechar a tampa: a comanda sai uma única vez. Anote o comportamento, porque ele depende do driver.
7. [ ] Tirar o papel e repetir o item 6.
8. [ ] Desligar o cabo de rede/Wi-Fi do computador e fazer um pedido pelo celular. Religar: a comanda sai uma única vez.
9. [ ] Reiniciar o computador: o serviço volta sozinho, e um pedido novo imprime.
10. [ ] Desligar a impressora no meio de uma impressão: o painel mostra "Resultado incerto". Conferir e decidir pelo painel.
11. [ ] Registrar no painel quanto tempo, em média, a comanda leva para sair após o pedido.

Anote o resultado de cada item. Os itens que falharem viram correção antes de divulgar o link.
