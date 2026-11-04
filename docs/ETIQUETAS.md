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

## Testado
- API: `apps/api/test/labels.test.ts` (permissões, cálculo da validade, lotes, validações, baixa).
- Navegador: `e2e/etiquetas.spec.ts` gera o PDF de impressão e confere 1 página por etiqueta em 50 x 30 mm.
- **Não testado em impressora de etiqueta física.**
