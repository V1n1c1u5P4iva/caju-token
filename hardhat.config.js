require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// Os segredos (RPC, chave privada, chave do Etherscan) vêm do arquivo .env, que fica
// fora do Git (.gitignore). Assim nenhuma chave privada é publicada no repositório.
const { SEPOLIA_RPC_URL, PRIVATE_KEY, ETHERSCAN_API_KEY, REPORT_GAS } = process.env;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  // Compilador fixado em 0.8.24 com o optimizer ligado (200 runs). O valor de "runs"
  // indica quantas vezes se espera que cada função seja chamada: 200 é o equilíbrio padrão
  // entre custo de deploy e custo de cada chamada. IMPORTANTE: a verificação no Etherscan
  // recompila o código com exatamente estas opções; se mudarem, o bytecode deixa de bater.
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    // Rede de testes pública Sepolia. Se não houver RPC próprio no .env, usa um RPC público.
    // Sem PRIVATE_KEY a lista de contas fica vazia: compilar e testar continua funcionando
    // (os testes usam a rede "hardhat" em memória), só o deploy na Sepolia é que exige a chave.
    // O chainId explícito impede enviar a transação para a rede errada por engano.
    sepolia: {
      url: SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 11155111,
    },
  },
  // Chave usada pelo plugin hardhat-verify para publicar o código-fonte no Etherscan.
  etherscan: { apiKey: ETHERSCAN_API_KEY || "" },
  // Relatório de gas: desligado por padrão para não poluir a saída do `npm test`.
  // `npm run gas` liga REPORT_GAS=true e grava a tabela em gas-report.txt (usada no README).
  // noColors evita códigos de cor ANSI dentro do arquivo de texto.
  gasReporter: {
    enabled: REPORT_GAS === "true",
    currency: "USD",
    outputFile: REPORT_GAS === "true" ? "gas-report.txt" : undefined,
    noColors: true,
  },
};

// Apenas para ambientes sem acesso a binaries.soliditylang.org: SOLC_LOCAL=true usa o solcjs do npm.
// Normalmente o Hardhat baixa o compilador nativo da internet. Em redes que bloqueiam esse
// download (ex.: laboratório da faculdade), este bloco intercepta a etapa interna do Hardhat
// que escolhe o compilador e aponta para o solcjs (versão JavaScript, pacote "solc" do npm).
// É a mesma versão 0.8.24, então gera o mesmo bytecode; qualquer outra versão segue o fluxo normal.
if (process.env.SOLC_LOCAL === "true") {
  const { subtask } = require("hardhat/config");
  const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");
  subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
    if (args.solcVersion === "0.8.24") {
      return { compilerPath: require.resolve("solc/soljson.js"), isSolcJs: true, version: "0.8.24", longVersion: "0.8.24+commit.e11b9ed9" };
    }
    return runSuper();
  });
}
