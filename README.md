# 🍊 CAJU — Cashback do comércio piauiense

Token **ERC-20** de cashback para o comércio local. Lojas parceiras dão de volta uma porcentagem de cada compra em CAJU; o cliente pode **transferir**, deixar **rendendo em staking** ou **resgatar benefícios** (o que queima os tokens).

> Prova prática 2 · Blockchain, Smart Contracts e Web3 · UESPI
> Rede: **Ethereum Sepolia** · Solidity 0.8.24 · OpenZeppelin 5 · Hardhat · React + ethers v6

| | |
|---|---|
| Contrato | `0x34cc40D721132AAd604F5D92f53516b288d7620c` |
| Etherscan | https://sepolia.etherscan.io/address/0x34cc40D721132AAd604F5D92f53516b288d7620c |
| Hash do deploy | `0x3ca5b6be2e7fd314b5934e8e0e4ab863352728ff70e9296b4c3bbe271527f5c1` |
| Frontend online | PREENCHER |
| Vídeo | PREENCHER |

---

## Requisitos da prova × onde estão

| Requisito | Implementação |
|---|---|
| Nome, símbolo, supply | `ERC20("Caju Cashback", "CAJU")`, `INITIAL_SUPPLY` 2 mi, `MAX_SUPPLY` 10 mi |
| Transferência e saldo | `transfer`, `transferFrom`, `balanceOf`, `totalSupply` (ERC-20 padrão) |
| `constructor` | define tesouraria, papéis, isenções e distribuição inicial |
| `mapping` | `isBlacklisted`, `isFeeExempt`, `stakes` |
| `require` | todas as validações (`"CAJU: ..."`) |
| Funções públicas | `darCashback`, `resgatar`, `stake`, `unstake`, `claimRewards`, `previewTransfer`… |
| **Extra 1 – Mint** | `darCashback()` e `mint()` só para `MINTER_ROLE` (lojas) |
| **Extra 2 – Burn** | `resgatar()` + `burn()`/`burnFrom()` |
| **Extra 3 – Taxa** | 1% por transferência → tesouraria (ajustável, máx. 5%) |
| **Extra 4 – Blacklist** | `setBlacklist()` (`COMPLIANCE_ROLE`) |
| **Extra 5 – Pause** | `pause()` / `unpause()` (`PAUSER_ROLE`) |
| **Extra 6 – Staking simples** | 12% a.a., rendimento por segundo, respeita o teto de supply |
| Bônus: OpenZeppelin | ERC20, Burnable, Pausable, Capped, AccessControl, ReentrancyGuard |
| Bônus: Segurança | controle de acesso por papéis, teto de supply, limites de taxa, `nonReentrant`, 24 testes |
| Bônus: Gas | `treasury`+`feeBps`+`cashbackBps` no mesmo slot, constantes, optimizer 200 runs |
| Bônus: Dashboard/design | frontend com painel do cliente e painel da loja/admin |

## Tokenomics

- **Supply máximo:** 10.000.000 CAJU (`ERC20Capped`)
- **Supply inicial:** 2.000.000 CAJU — 70% (1,4 mi) fundo de cashback/operação (deployer), 30% (600 mil) tesouraria
- **Emissão futura (até 8 mi):** apenas por cashback das lojas, campanhas (`mint`) e rendimento de staking
- **Utilidade:** 1 CAJU ≈ R$ 1,00 em benefícios nas lojas parceiras
- **Cashback:** 5% do valor da compra (ajustável até 20%). Ex.: compra de R$ 200 → 10 CAJU
- **Taxa:** 1% por transferência entre usuários, vai para a tesouraria (financia o programa). Staking, mint e burn não pagam taxa
- **Deflação:** todo resgate de benefício queima os tokens
- **Staking:** 12% ao ano, linear

## Arquitetura

```
Usuário ── MetaMask ── Frontend React (ethers v6) ──RPC──► Sepolia ──► CajuToken.sol
                                 ▲                                         │
                                 └────────── eventos (Transfer, CashbackConcedido, ...) ◄┘
```

```
caju-token/
├── contracts/CajuToken.sol    # smart contract
├── test/CajuToken.test.js     # 24 testes (Hardhat + Chai)
├── scripts/deploy.js          # deploy + grava endereço/ABI no frontend + verifica no Etherscan
├── frontend/                  # React + Vite
│   └── src/contract.json      # gerado pelo deploy
├── deployment.json            # dados do deploy (para o relatório)
└── gas-report.txt             # custos de gas (npm run gas)
```

## Custos (gas medido nos testes)

| Operação | Gas |
|---|---|
| Deploy do contrato | ~2.213.000 |
| `transfer` (sem / com taxa) | ~58.000 / ~75.000 |
| `darCashback` | ~48.000–65.000 |
| `resgatar` (burn) | ~44.000 |
| `stake` | ~133.000 |
| `unstake` | ~73.000–105.000 |
| `claimRewards` | ~76.000–93.000 |
| `setBlacklist` | ~28.000–50.000 |
| `pause` / `unpause` | ~47.000 / ~25.000 |
| **Deploy real na Sepolia** (bloco 12190274) | 14.933.880 gas × 1,0 gwei = **0,01493388 ETH** |

Custo em ETH = gas × preço do gas. O valor real do deploy na Sepolia fica em `deployment.json` (o script imprime).

---

## Como rodar

Pré-requisitos: Node 18+ e MetaMask.

```bash
npm install
npm --prefix frontend install
npm test              # 24 testes
npm run gas           # gera gas-report.txt
npm run coverage      # cobertura (~97%)
```

### Testar tudo localmente (sem gastar nada)

```bash
npm run node                 # terminal 1: blockchain local
npm run deploy:local         # terminal 2
npm run frontend             # abre em http://localhost:5173
```
Na MetaMask, adicione a rede `http://127.0.0.1:8545` (chain id 31337) e importe a chave da conta #0 que o `hardhat node` mostra.

### Deploy na Sepolia

1. Na MetaMask, ative "Mostrar redes de teste" e selecione **Sepolia**.
2. Pegue ETH de teste num faucet (ex.: Google Cloud Web3 Faucet, Alchemy ou Infura Sepolia faucet). ~0,02 ETH sobra.
3. `cp .env.example .env` e preencha `PRIVATE_KEY` (de uma carteira **só de testes**!).
   Recomendado: crie uma **segunda conta** na MetaMask e coloque o endereço em `TREASURY_ADDRESS` — assim a taxa aparece indo para uma carteira separada.
4. Opcional: `ETHERSCAN_API_KEY` para verificar o código automaticamente.
5. `npm run deploy:sepolia` → anote endereço, hash e link que aparecem no terminal.
6. `npm run frontend` (ou publique: `npm --prefix frontend run build` e suba `frontend/dist` na Vercel/Netlify/GitHub Pages).

> A carteira que fez o deploy é **isenta de taxa**. Para mostrar a taxa no vídeo, envie CAJU para uma terceira conta e transfira **a partir dela**.

---

## Roteiro do vídeo (≤ 5 min)

1. **(0:00)** Problema e ideia: cashback do comércio local em token.
2. **(0:30)** Contrato no VS Code: herança OpenZeppelin, `constructor`, `mapping`s, `require`, `_update` (taxa + blacklist).
3. **(1:15)** `npm test` mostrando os 24 testes passando.
4. **(1:40)** Etherscan: contrato verificado, hash do deploy.
5. **(2:00)** Frontend: conectar MetaMask, saldo, adicionar token à MetaMask.
6. **(2:30)** Painel da loja: compra de R$ 200 → cliente recebe 10 CAJU.
7. **(3:00)** Na conta do cliente: transferir (mostrar prévia da taxa de 1%), staking com rendimento ao vivo, resgatar benefício (supply diminui).
8. **(4:00)** Admin: bloquear carteira (transferência falha), pausar e retomar.
9. **(4:40)** Encerramento: gas e próximos passos.

## Licença
MIT
